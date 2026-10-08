import { describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client.ts'
import { operationHistory } from '../src/db/schema.ts'
import { createIndexer, extractOperations, type Tx } from '../src/bots/indexer.ts'
import type { Deployment } from '../src/deployment.ts'
import type { LedgerClient } from '../src/ledger/client.ts'

const tx = {
  updateId: 'u1',
  offset: 10,
  effectiveAt: '2026-09-29T10:00:00Z',
  events: [
    {
      ExercisedEvent: {
        nodeId: 0,
        choice: 'Pool_WithdrawBase',
        choiceArgument: { user: 'bob', amount: '3000', allowBorrow: true },
        lastDescendantNodeId: 1,
      },
    },
    { ExercisedEvent: { nodeId: 1, choice: 'TransferFactory_Transfer', choiceArgument: {} } },
  ],
}

describe('history of Loop accounts (0.7.0)', () => {
  const party = 'alice-loop::1220' + 'ab'.repeat(32)
  const custody = 'custody::1220' + 'cd'.repeat(32)
  it('records Pool_LoopWalletExecute under loop:<party> with the moved amount', () => {
    const rows = extractOperations({
      updateId: 'u-loop',
      offset: 42,
      effectiveAt: '2026-10-01T10:00:00Z',
      events: [
        {
          ExercisedEvent: {
            nodeId: 0,
            choice: 'Pool_LoopWalletExecute',
            choiceArgument: {
              custody,
              action: { tag: 'EvmSupply', value: { amount: '1000.0' } },
              signedMessage: 'x',
              signature: 'y',
            },
            lastDescendantNodeId: 3,
          },
        },
        {
          ExercisedEvent: {
            nodeId: 1,
            choice: 'TransferFactory_Transfer',
            choiceArgument: {
              transfer: { sender: custody, receiver: 'operator', amount: '1000.0' },
            },
          },
        },
        {
          CreatedEvent: {
            nodeId: 2,
            templateId: 'pkg:Lending.Account:Account',
            createArgument: { owner: custody, operator: 'operator', loopParty: party },
          },
        },
      ],
    } as unknown as Tx)
    expect(rows).toEqual([
      expect.objectContaining({ party: `loop:${party}`, op: 'supply', amount: '1000.0000000000' }),
    ])
  })
  it('records LoopDirectory_Open as open-account of loop:<party>', () => {
    const rows = extractOperations({
      updateId: 'u-open',
      offset: 41,
      effectiveAt: '2026-10-01T09:59:00Z',
      events: [
        {
          ExercisedEvent: {
            nodeId: 0,
            choice: 'LoopDirectory_Open',
            choiceArgument: { party, publicKey: 'ab'.repeat(32) },
            lastDescendantNodeId: 2,
          },
        },
      ],
    } as unknown as Tx)
    expect(rows).toEqual([expect.objectContaining({ party: `loop:${party}`, op: 'open-account' })])
  })
})

describe('history indexer', () => {
  it('keeps only user operations of the pool: a borrow is a Withdraw', () => {
    expect(extractOperations(tx)).toEqual([
      expect.objectContaining({ party: 'bob', op: 'withdraw', amount: '3000', nodeId: 0 }),
    ])
  })

  it('does not duplicate an event on replay', () => {
    const db = createDb(':memory:')
    const rows = extractOperations(tx)
    db.insert(operationHistory).values(rows).onConflictDoNothing().run()
    db.insert(operationHistory).values(rows).onConflictDoNothing().run()
    expect(db.select().from(operationHistory).all()).toHaveLength(1)
  })

  const transfer = (nodeId: number, sender: string, receiver: string, amount: string) => ({
    ExercisedEvent: {
      nodeId,
      lastDescendantNodeId: nodeId + 4,
      choice: 'TransferFactory_Transfer',
      choiceArgument: { transfer: { sender, receiver, amount } },
    },
  })
  const accountCreated = (owner: string, principal: string, collateral: [string, string][]) => ({
    CreatedEvent: {
      templateId: 'pkg:Lending.Account:Account',
      createArgument: { operator: 'op', owner, principal, collateral },
    },
  })
  const poolCreated = (borrowIndex = '1', basis = '0') => ({
    CreatedEvent: {
      templateId: 'pkg:Lending.Pool:Pool',
      createArgument: {
        operator: 'op',
        governors: [],
        markets: [
          ['CC', { totalCollateral: '0', protocolCollateral: '0', protocolCollateralBasis: basis }],
        ],
        state: {
          totalSupplyPrincipal: '0',
          totalBorrowPrincipal: '0',
          supplyIndex: '1',
          borrowIndex,
          cash: '0',
          lastUpdate: '2026-09-29T10:00:00Z',
        },
      },
    },
  })

  it('records the executed amount of withdraw-all, not the requested one (L4)', () => {
    const rows = extractOperations({
      ...tx,
      events: [
        {
          ExercisedEvent: {
            nodeId: 0,
            lastDescendantNodeId: 15,
            choice: 'Pool_WithdrawBase',
            choiceArgument: { user: 'alice', amount: '20000', full: true, allowBorrow: false },
          },
        },
        transfer(3, 'op', 'alice', '20010.0001354721'),
      ],
    })
    expect(rows).toEqual([expect.objectContaining({ op: 'withdraw', amount: '20010.0001354721' })])
  })

  it('a supply that repays the debt carries the repaid part (example 2)', () => {
    const before = accountCreated('bob', '-1000', []).CreatedEvent.createArgument
    const rows = extractOperations(
      {
        ...tx,
        events: [
          {
            ExercisedEvent: {
              nodeId: 0,
              lastDescendantNodeId: 18,
              choice: 'Pool_SupplyBase',
              choiceArgument: { user: 'bob', amount: '1500', full: false },
            },
          },
          transfer(3, 'bob', 'op', '1500'),
          accountCreated('bob', '500', []),
          poolCreated(),
        ],
      },
      (k) => (k === 'bob' ? (before as never) : undefined),
    )
    expect(rows).toEqual([
      expect.objectContaining({
        op: 'supply',
        amount: '1500.0000000000',
        debtPart: '1000.0000000000',
      }),
    ])
  })

  it('a withdraw that borrows carries the borrowed part (example 3)', () => {
    const before = accountCreated('bob', '500', []).CreatedEvent.createArgument
    const rows = extractOperations(
      {
        ...tx,
        events: [
          {
            ExercisedEvent: {
              nodeId: 0,
              lastDescendantNodeId: 18,
              choice: 'Pool_WithdrawBase',
              choiceArgument: { user: 'bob', amount: '800', full: false, allowBorrow: true },
            },
          },
          transfer(3, 'op', 'bob', '800'),
          accountCreated('bob', '-300', []),
          poolCreated(),
        ],
      },
      (k) => (k === 'bob' ? (before as never) : undefined),
    )
    expect(rows[0]).toMatchObject({
      op: 'withdraw',
      amount: '800.0000000000',
      debtPart: '300.0000000000',
    })
  })

  it('an account from before the indexed history: the borrowed part is unknown, not invented', () => {
    const rows = extractOperations(
      {
        ...tx,
        events: [
          {
            ExercisedEvent: {
              nodeId: 0,
              lastDescendantNodeId: 18,
              choice: 'Pool_WithdrawBase',
              choiceArgument: { user: 'bob', amount: '800', full: false, allowBorrow: true },
            },
          },
          // the old account is consumed: it existed, but the indexer has no state of it
          {
            ExercisedEvent: {
              nodeId: 1,
              templateId: 'pkg:Lending.Account:Account',
              consuming: true,
              choice: 'Archive',
              choiceArgument: {},
            },
          },
          transfer(3, 'op', 'bob', '800'),
          accountCreated('bob', '-300', []),
          poolCreated(),
        ],
      },
      () => undefined,
    )
    expect(rows[0]).toMatchObject({ op: 'withdraw', amount: '800.0000000000', debtPart: null })
  })

  it('ignores transfers outside the choice subtree', () => {
    const rows = extractOperations({
      ...tx,
      events: [
        {
          ExercisedEvent: {
            nodeId: 0,
            lastDescendantNodeId: 2,
            choice: 'Pool_SupplyBase',
            choiceArgument: { user: 'alice', amount: '100' },
          },
        },
        transfer(5, 'alice', 'op', '999'),
      ],
    })
    expect(rows[0]!.amount).toBe('100')
  })

  it('absorb: debt written off, collateral taken and USDCx credited (example 4)', async () => {
    const db = createDb(':memory:')
    const deposit: Tx = {
      updateId: 'u-dep',
      offset: 1,
      effectiveAt: tx.effectiveAt,
      events: [
        {
          ExercisedEvent: {
            nodeId: 0,
            lastDescendantNodeId: 9,
            choice: 'Pool_SupplyCollateral',
            choiceArgument: { user: 'carol', marketId: 'CC', amount: '50000' },
          },
        },
        transfer(2, 'carol', 'op', '50000'),
        accountCreated('carol', '-3000', [['CC', '50000']]),
        poolCreated('1', '0'),
      ],
    }
    const absorb: Tx = {
      updateId: 'u-abs',
      offset: 2,
      effectiveAt: tx.effectiveAt,
      events: [
        {
          ExercisedEvent: {
            nodeId: 0,
            lastDescendantNodeId: 3,
            choice: 'Pool_Absorb',
            choiceArgument: { accountCid: 'acc' },
          },
        },
        accountCreated('carol', '3045', []),
        poolCreated('1', '6045'),
      ],
    }
    const ledger = {
      ledgerEnd: async () => 2,
      prunedOffset: async () => 0,
      participantId: async () => 'participant::1',
      updates: async (_p: string, _t: string[], from: number) =>
        from === 0
          ? { transactions: [deposit, absorb], lastOffset: 2, count: 2 }
          : { transactions: [], lastOffset: null, count: 0 },
    } as unknown as LedgerClient
    const indexer = createIndexer(ledger, { operator: 'op' } as Deployment, db)
    expect(await indexer.step()).toBe(2)
    expect(await indexer.step()).toBe(0)
    const rows = indexer.history('carol')
    expect(rows[0]).toMatchObject({
      op: 'absorb',
      amount: '3000.0000000000',
      credited: '6045.0000000000',
      collateralTaken: [{ marketId: 'CC', amount: '50000.0000000000' }],
      // review 03.10, item 6: the debt is repaid from the credit, 3 045 stays as a deposit
      balanceAfter: '3045.0000000000',
    })
    expect(rows[1]).not.toHaveProperty('balanceAfter', expect.any(String))
    expect(rows[1]).toMatchObject({ op: 'deposit-collateral', amount: '50000.0000000000' })
  })

  it('starts after the pruned offset of a shared node', async () => {
    const db = createDb(':memory:')
    const froms: number[] = []
    const ledger = {
      ledgerEnd: async () => 500,
      prunedOffset: async () => 400,
      participantId: async () => 'participant::1',
      updates: async (_p: string, _t: string[], from: number) => {
        froms.push(from)
        return { transactions: [], lastOffset: null, count: 0 }
      },
    } as unknown as LedgerClient
    const indexer = createIndexer(ledger, { operator: 'op' } as Deployment, db)
    await indexer.step()
    expect(froms).toEqual([400])
  })
})
