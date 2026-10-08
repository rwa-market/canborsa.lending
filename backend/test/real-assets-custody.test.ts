/**
 * Real assets, deposits bot: one-step deposits (CC via TransferPreapproval) through
 * EvmWallet_CreditDeposit, reclaim of an expired withdrawal (EvmWallet_ReclaimTransferOut) and
 * refund of a withdrawal the receiver rejected (CreditDeposit with depositRef refund:<cid>).
 * Ledger, registry and wallet are stubs; transaction shape per the Exchange Integration Guide.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { parseCustodyTransaction } from '../src/assets/custody-tx.ts'
import {
  REAL_PROFILES,
  REASON_META_KEY,
  SENDER_META_KEY,
  TX_KIND_META_KEY,
} from '../src/assets/profiles.ts'
import { createRealAssetsStore } from '../src/assets/store.ts'
import { attributedAddress, createDepositsBot, creditAddress } from '../src/bots/deposits.ts'
import type { Deployment } from '../src/deployment.ts'
import {
  LedgerError,
  type LedgerClient,
  type LedgerTransaction,
  type LedgerTxEvent,
} from '../src/ledger/client.ts'
import { INTERFACES, TEMPLATES } from '../src/ledger/ids.ts'
import { createMetrics } from '../src/metrics.ts'
import { explainRejection } from '../src/protocol/errors.ts'
import type { Evm } from '../src/protocol/evm.ts'
import type { Reader } from '../src/protocol/reader.ts'
import type { TokenRegistry } from '../src/protocol/registry.ts'
import { d, holding, log, p, snapshot } from './fixtures.ts'

const profile = REAL_PROFILES.testnet
const cc = profile.instruments.cc
const custody = p('Custody')
const sender = p('Sender')
const dep = { ...d, ...profile.instruments, evm: { custody } } as Deployment
const ADDRESS = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'
const CHECKSUM = '0x2C7536E3605D9c16a7a3D7b1898e529396a65c23'
const HOLDING_IFACE = 'pkgh:Splice.Api.Token.HoldingV1:Holding'
const INSTRUCTION_IFACE = 'pkgt:Splice.Api.Token.TransferInstructionV1:TransferInstruction'

const created = (
  nodeId: number,
  cid: string,
  owner: string,
  amount: string,
  instrumentId = cc,
): LedgerTxEvent => ({
  CreatedEvent: {
    nodeId,
    contractId: cid,
    templateId: 'pkga:Splice.Amulet:Amulet',
    interfaceViews: [
      { interfaceId: HOLDING_IFACE, viewValue: { owner, instrumentId, amount, lock: null } },
    ],
  },
})

const exercised = (
  nodeId: number,
  last: number,
  o: {
    choice: string
    templateId?: string
    cid?: string
    result?: unknown
    arg?: unknown
    consuming?: boolean
    interfaces?: string[]
  },
): LedgerTxEvent => ({
  ExercisedEvent: {
    nodeId,
    lastDescendantNodeId: last,
    contractId: o.cid ?? `c-${nodeId}`,
    templateId: o.templateId ?? 'pkga:Splice.AmuletRules:TransferPreapproval',
    choice: o.choice,
    choiceArgument: o.arg ?? {},
    exerciseResult: o.result ?? {},
    consuming: o.consuming ?? false,
    implementedInterfaces: o.interfaces ?? [],
  },
})

const transferMeta = (reason?: string, from = sender) => ({
  meta: {
    values: {
      [TX_KIND_META_KEY]: 'transfer',
      [SENDER_META_KEY]: from,
      ...(reason === undefined ? {} : { [REASON_META_KEY]: reason }),
    },
  },
})

/** One-step deposit as in the guide: node 4 is the transfer, 11 the sender's change, 12 ours. */
const preapprovedDeposit = (
  updateId: string,
  offset: number,
  reason: string | undefined,
  amount = '200.0000000000',
): LedgerTransaction => ({
  updateId,
  offset,
  events: [
    exercised(4, 12, { choice: 'TransferPreapproval_Send', result: transferMeta(reason) }),
    exercised(5, 10, {
      choice: 'AmuletRules_Transfer',
      templateId: 'pkga:Splice.AmuletRules:AmuletRules',
    }),
    created(11, `change-${updateId}`, sender, '50.0'),
    created(12, `h-${updateId}`, custody, amount),
  ],
})

/** Receiver rejected the withdrawal: consuming Reject on the instruction, change to custodian. */
const rejected = (updateId: string, offset: number, instructionCid: string): LedgerTransaction => ({
  updateId,
  offset,
  events: [
    exercised(0, 2, {
      choice: 'TransferInstruction_Reject',
      templateId: 'pkga:Splice.AmuletTransferInstruction:AmuletTransferInstruction',
      cid: instructionCid,
      consuming: true,
      interfaces: [INSTRUCTION_IFACE],
      result: {
        output: { tag: 'TransferInstructionResult_Failed', value: {} },
        senderChangeCids: ['back-1'],
      },
    }),
    created(2, 'back-1', custody, '30.0'),
  ],
})

const outbound = (cid: string, o: { executeBefore: string; reason?: string; amount?: string }) => ({
  contractId: cid,
  templateId: 'reg:TransferInstruction',
  createdEventBlob: 'b',
  synchronizerId: 's',
  payload: {},
  interfaceView: {
    transfer: {
      sender: custody,
      receiver: p('Bob'),
      amount: o.amount ?? '30.0',
      instrumentId: cc,
      executeBefore: o.executeBefore,
      meta: { values: { [REASON_META_KEY]: o.reason ?? `lending:evm:${ADDRESS}` } },
    },
  },
})

describe('custody transaction parsing', () => {
  it('finds a 1-step deposit: memo from the transfer node, amount from our holdings under it', () => {
    const r = parseCustodyTransaction(
      preapprovedDeposit('upd-1', 10, `lending:evm:${ADDRESS}`),
      custody,
    )
    expect(r.returned).toEqual([])
    expect(r.incoming).toEqual([
      {
        depositRef: 'upd-1:4',
        nodeId: 4,
        reason: `lending:evm:${ADDRESS}`,
        sender,
        instrument: cc,
        amount: '200',
        holdingCids: ['h-upd-1'],
      },
    ])
  })

  it('skips our own choices, our own withdrawals and merges', () => {
    const own: LedgerTransaction = {
      updateId: 'upd-own',
      offset: 11,
      events: [
        // ReceiveAttributed: inside Accept with meta transfer, credited by the choice itself
        exercised(0, 3, {
          choice: 'EvmWallet_ReceiveAttributed',
          templateId: 'pkgl:Lending.Evm:EvmWallet',
        }),
        exercised(1, 3, {
          choice: 'TransferInstruction_Accept',
          result: transferMeta(`lending:evm:${ADDRESS}`),
        }),
        created(3, 'h-own', custody, '5.0'),
        // our withdrawal via the factory: change to the custodian
        exercised(4, 5, {
          choice: 'TransferFactory_Transfer',
          result: transferMeta(undefined, custody),
        }),
        created(5, 'h-change', custody, '1.0'),
        // validator merge-split: not a transfer
        exercised(6, 7, {
          choice: 'AmuletRules_Transfer',
          result: { meta: { values: { [TX_KIND_META_KEY]: 'merge-split' } } },
        }),
        created(7, 'h-merged', custody, '6.0'),
        // xReserve mint to the custodian
        exercised(8, 9, {
          choice: 'BridgeUserAgreement_Mint',
          templateId: 'pkgu:Utility.Bridge:BridgeUserAgreement',
        }),
        created(9, 'h-mint', custody, '25.0', profile.instruments.usdcx),
      ],
    }
    expect(parseCustodyTransaction(own, custody)).toEqual({ incoming: [], returned: [] })
  })

  it('reports a failed instruction outcome outside our choices, not our own reclaim', () => {
    expect(parseCustodyTransaction(rejected('upd-r', 12, 'ti-out'), custody).returned).toEqual([
      { instructionCid: 'ti-out', nodeId: 0, choice: 'TransferInstruction_Reject' },
    ])
    const reclaim: LedgerTransaction = {
      updateId: 'upd-rc',
      offset: 13,
      events: [
        exercised(0, 3, {
          choice: 'EvmWallet_ReclaimTransferOut',
          templateId: 'pkgl:Lending.Evm:EvmWallet',
        }),
        ...rejected('x', 0, 'ti-out').events.map((e) =>
          e.ExercisedEvent
            ? {
                ExercisedEvent: {
                  ...e.ExercisedEvent,
                  nodeId: 1,
                  lastDescendantNodeId: 2,
                  choice: 'TransferInstruction_Withdraw',
                },
              }
            : e,
        ),
      ],
    }
    expect(parseCustodyTransaction(reclaim, custody)).toEqual({ incoming: [], returned: [] })
  })
})

describe('deposit memo forms', () => {
  it('CreditDeposit normalises a checksum address; ReceiveAttributed stays exact', () => {
    expect(creditAddress(`lending:evm:${CHECKSUM}`)).toBe(ADDRESS)
    expect(creditAddress(`lending:evm:${ADDRESS}`)).toBe(ADDRESS)
    expect(attributedAddress(`lending:evm:${CHECKSUM}`)).toBeNull()
    // the prefix is exact, garbage does not pass
    expect(creditAddress(`LENDING:EVM:${ADDRESS}`)).toBeNull()
    expect(creditAddress(`lending:evm:${ADDRESS}0`)).toBeNull()
    expect(creditAddress(`lending:evm:0X${ADDRESS.slice(2)}`)).toBeNull()
    expect(creditAddress(undefined)).toBeNull()
  })
})

interface State {
  end: number
  txs: LedgerTransaction[]
  instructions: ReturnType<typeof outbound>[]
  instructionViews: Record<string, unknown>
  refs: string[]
  /** submission failure: chosen per command */
  fail?: (choice: string, arg: Record<string, unknown>) => unknown
  registry?: boolean
}

function botWith(st: State, clock = { t: Date.parse('2030-01-02T00:00:00Z') }) {
  const store = createRealAssetsStore(new Database(':memory:'))
  const metrics = createMetrics()
  const submitted: { choice: string; arg: Record<string, unknown>; commandId: string }[] = []
  const withdrawCalls: string[] = []
  const ledger = {
    query: async (_party: string, f: { interfaceId?: string; templateId?: string }) => {
      if (f.interfaceId === INTERFACES.transferInstruction) return st.instructions
      if (f.templateId === TEMPLATES.depositRegistry && st.registry !== false)
        return [
          {
            contractId: 'registry-1',
            templateId: 't',
            createdEventBlob: 'b',
            synchronizerId: 's',
            payload: { operator: d.operator, custody, refs: { map: st.refs.map((r) => [r, {}]) } },
          },
        ]
      return []
    },
    ledgerEnd: async () => st.end,
    prunedOffset: async () => 0,
    transactions: async (_party: string, from: number, end: number, limit: number) => {
      const txs = st.txs.filter((t) => t.offset > from && t.offset <= end).slice(0, limit)
      return {
        transactions: txs,
        lastOffset: txs.length ? Math.max(...txs.map((t) => t.offset)) : null,
        count: txs.length,
      }
    },
    createdEvent: async (_party: string, cid: string) =>
      st.instructionViews[cid]
        ? { contractId: cid, interfaceView: st.instructionViews[cid] }
        : null,
    submit: async (
      _actAs: string[],
      cmds: { ExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> } }[],
      _disclosed: unknown,
      _readAs: unknown,
      o: { commandId: string },
    ) => {
      const ex = cmds[0]!.ExerciseCommand
      const err = st.fail?.(ex.choice, ex.choiceArgument)
      if (err) throw err
      if (ex.choice === 'EvmWallet_CreditDeposit') {
        const ref = ex.choiceArgument.depositRef as string
        if (st.refs.includes(ref)) throw new LedgerError('x', 400, null, 'deposit already credited')
        st.refs.push(ref)
      }
      submitted.push({ choice: ex.choice, arg: ex.choiceArgument, commandId: o.commandId })
      return { updateId: `upd-sub-${submitted.length}`, events: [] }
    },
  } as unknown as LedgerClient
  const reader = {
    snapshot: async () => snapshot(),
    holdings: async () => [holding('pool-h', custody, '100000', cc)],
    evmWallet: async (a: string) => (a === ADDRESS ? { contractId: 'wallet-1' } : null),
  } as unknown as Reader
  const evm = {
    ensureAccount: async () => undefined,
    reclaimTransferOut: async (a: string, cid: string, ctx: { extraArgs: unknown }) => {
      const err = st.fail?.('EvmWallet_ReclaimTransferOut', { cid })
      if (err) throw err
      submitted.push({
        choice: 'EvmWallet_ReclaimTransferOut',
        arg: { address: a, instructionCid: cid, extraArgs: ctx.extraArgs },
        commandId: `evm-reclaim-${cid}`,
      })
      return { updateId: 'upd-reclaim', events: [] }
    },
  } as unknown as Evm
  const registry: TokenRegistry = {
    transferFactory: async () => {
      throw new Error('unused')
    },
    withdrawContext: async (_i, cid) => {
      withdrawCalls.push(cid)
      return {
        extraArgs: { context: { values: { round: cid } }, meta: { values: {} } },
        disclosed: [],
      }
    },
  }
  const step = createDepositsBot({
    ledger,
    reader,
    evm,
    registry,
    store,
    deployment: dep,
    profile,
    log,
    metrics,
    now: () => clock.t,
  })
  return { step, store, submitted, metrics, withdrawCalls, clock }
}

const credits = (s: { choice: string; arg: Record<string, unknown> }[]) =>
  s.filter((x) => x.choice === 'EvmWallet_CreditDeposit').map((x) => x.arg)

describe('deposits bot: direct deposits', () => {
  it('starts the stream at the ledger end, then credits a checksum memo deposit once', async () => {
    const st: State = { end: 5, txs: [], instructions: [], instructionViews: {}, refs: [] }
    const b = botWith(st)
    await b.step()
    expect(b.store.cursor('custody')).toBe(5)
    st.txs.push(preapprovedDeposit('upd-1', 10, `lending:evm:${CHECKSUM}`))
    st.end = 10
    await b.step()
    await b.step()
    expect(credits(b.submitted)).toEqual([
      {
        configCid: 'cfg',
        registryCid: 'registry-1',
        holdingCids: ['pool-h'],
        instrumentId: { admin: cc.admin, id: 'Amulet' },
        amount: '200',
        depositRef: 'upd-1:4',
      },
    ])
    expect(b.submitted[0]!.commandId).toMatch(/^evm-credit-[0-9a-f]{40}$/)
    expect(b.store.seen('upd-1:4')).toBe('credited')
    expect(b.store.cursor('custody')).toBe(10)
    expect(b.metrics.get('deposits_credited_total', { slot: 'cc' })).toBe(1)
  })

  it('a replay after a lost SQLite state is refused by the registry, not credited twice', async () => {
    const st: State = {
      end: 10,
      txs: [preapprovedDeposit('upd-1', 10, `lending:evm:${ADDRESS}`)],
      instructions: [],
      instructionViews: {},
      refs: ['upd-1:4'],
    }
    const b = botWith(st)
    b.store.setCursor('custody', 0)
    await b.step()
    expect(credits(b.submitted)).toEqual([])
    expect(b.store.seen('upd-1:4')).toBe('credited')
    expect(st.refs).toEqual(['upd-1:4'])
  })

  it('quarantines a direct deposit without a memo or with a foreign memo', async () => {
    const st: State = {
      end: 12,
      txs: [
        preapprovedDeposit('upd-a', 10, undefined),
        preapprovedDeposit('upd-b', 11, 'order 42'),
        preapprovedDeposit('upd-c', 12, `lending:evm:${ADDRESS.slice(0, 20)}`),
      ],
      instructions: [],
      instructionViews: {},
      refs: [],
    }
    const b = botWith(st)
    b.store.setCursor('custody', 0)
    await b.step()
    expect(credits(b.submitted)).toEqual([])
    expect(b.store.quarantineOpen().map((r) => [r.id, r.source, r.cause, r.amount])).toEqual([
      ['upd-a:4', 'preapproval', 'no-reason', '200'],
      ['upd-b:4', 'preapproval', 'bad-reason', '200'],
      ['upd-c:4', 'preapproval', 'bad-reason', '200'],
    ])
    expect(b.store.cursor('custody')).toBe(12)
  })

  it('a transient failure keeps the cursor before the transaction; the retry credits it', async () => {
    let down = true
    const st: State = {
      end: 11,
      txs: [
        preapprovedDeposit('upd-1', 10, `lending:evm:${ADDRESS}`),
        preapprovedDeposit('upd-2', 11, `lending:evm:${ADDRESS}`, '7.5'),
      ],
      instructions: [],
      instructionViews: {},
      refs: [],
      fail: (_c, arg) => (down && arg.depositRef === 'upd-2:4' ? new Error('fetch failed') : null),
    }
    const b = botWith(st)
    b.store.setCursor('custody', 0)
    await expect(b.step()).rejects.toThrow(/fetch failed/)
    expect(b.store.cursor('custody')).toBe(10)
    down = false
    await b.step()
    expect(credits(b.submitted).map((a) => [a.depositRef, a.amount])).toEqual([
      ['upd-1:4', '200'],
      ['upd-2:4', '7.5'],
    ])
    expect(b.store.cursor('custody')).toBe(11)
  })

  it('without a DepositRegistry the deposit waits (retry), it is not quarantined', async () => {
    const st: State = {
      end: 10,
      txs: [preapprovedDeposit('upd-1', 10, `lending:evm:${ADDRESS}`)],
      instructions: [],
      instructionViews: {},
      refs: [],
      registry: false,
    }
    const b = botWith(st)
    b.store.setCursor('custody', 0)
    await expect(b.step()).rejects.toThrow(/assets:setup-registry/)
    expect(b.store.quarantineOpen()).toEqual([])
    expect(b.store.cursor('custody')).toBe(0)
  })
})

describe('deposits bot: failed withdrawals', () => {
  const view = (o: { reason?: string; sender?: string } = {}) => ({
    transfer: {
      sender: o.sender ?? custody,
      receiver: p('Bob'),
      amount: '30.0',
      instrumentId: cc,
      executeBefore: '2030-01-02T00:00:00Z',
      meta: { values: { [REASON_META_KEY]: o.reason ?? `lending:evm:${ADDRESS}` } },
    },
  })

  it('a rejected withdrawal is credited back once with depositRef refund:<cid>', async () => {
    const st: State = {
      end: 20,
      txs: [rejected('upd-r', 20, 'ti-out')],
      instructions: [],
      instructionViews: { 'ti-out': view() },
      refs: [],
    }
    const b = botWith(st)
    b.store.setCursor('custody', 0)
    await b.step()
    b.store.setCursor('custody', 0) // replay of the same stream
    await b.step()
    expect(credits(b.submitted)).toEqual([
      expect.objectContaining({
        amount: '30',
        depositRef: 'refund:ti-out',
        instrumentId: { admin: cc.admin, id: 'Amulet' },
      }),
    ])
    expect(b.store.seen('refund:ti-out')).toBe('credited')
    expect(b.metrics.get('deposits_refunded_total', { slot: 'cc' })).toBe(1)
  })

  it('a returned transfer that is not from an EVM wallet goes to quarantine; a foreign incoming one is ignored', async () => {
    const st: State = {
      end: 22,
      txs: [rejected('u1', 20, 'ti-x'), rejected('u2', 21, 'ti-gone'), rejected('u3', 22, 'ti-in')],
      instructions: [],
      instructionViews: { 'ti-x': view({ reason: 'payout' }), 'ti-in': view({ sender: sender }) },
      refs: [],
    }
    const b = botWith(st)
    b.store.setCursor('custody', 0)
    await b.step()
    expect(credits(b.submitted)).toEqual([])
    expect(b.store.quarantineOpen().map((r) => [r.id, r.cause])).toEqual([
      ['refund:ti-x', 'refund-unattributed'],
      ['refund:ti-gone', 'refund-unattributed'],
    ])
  })

  it('reclaims an expired withdrawal with the registry withdraw context, once', async () => {
    const st: State = {
      end: 0,
      txs: [],
      instructions: [
        outbound('ti-old', { executeBefore: '2030-01-01T23:58:00Z' }),
        outbound('ti-live', { executeBefore: '2030-01-02T12:00:00Z' }),
        // within the clock skew allowance
        outbound('ti-edge', { executeBefore: '2030-01-01T23:59:30Z' }),
        // not an EVM wallet withdrawal
        outbound('ti-ops', { executeBefore: '2030-01-01T00:00:00Z', reason: 'ops' }),
      ],
      instructionViews: {},
      refs: [],
    }
    const b = botWith(st)
    await b.step()
    await b.step()
    expect(b.withdrawCalls).toEqual(['ti-old'])
    expect(b.submitted).toEqual([
      {
        choice: 'EvmWallet_ReclaimTransferOut',
        arg: {
          address: ADDRESS,
          instructionCid: 'ti-old',
          extraArgs: { context: { values: { round: 'ti-old' } }, meta: { values: {} } },
        },
        commandId: 'evm-reclaim-ti-old',
      },
    ])
    expect(b.store.seen('reclaim:ti-old')).toBe('credited')
    expect(b.metrics.get('deposits_reclaimed_total', { slot: 'cc' })).toBe(1)
  })

  it('a reclaim of an instruction that is already gone is left to the stream; other refusals are quarantined', async () => {
    const st: State = {
      end: 0,
      txs: [],
      instructions: [
        outbound('ti-gone', { executeBefore: '2030-01-01T00:00:00Z' }),
        outbound('ti-bad', { executeBefore: '2030-01-01T00:00:00Z' }),
      ],
      instructionViews: {},
      refs: [],
      fail: (_c, arg) =>
        arg.cid === 'ti-gone'
          ? new LedgerError(
              'x',
              404,
              null,
              'STALE_CONTRACT: state changed, prepare the command again',
            )
          : arg.cid === 'ti-bad'
            ? new LedgerError('x', 400, null, 'withdrawn transfer did not return the tokens')
            : null,
    }
    const b = botWith(st)
    await b.step()
    expect(b.store.quarantineOpen().map((r) => [r.id, r.cause, r.detail])).toEqual([
      ['reclaim:ti-bad', 'reclaim-rejected', 'withdrawn transfer did not return the tokens'],
    ])
    expect(b.store.seen('reclaim:ti-gone')).toBeNull()
  })
})

describe('registry fees', () => {
  it('a fee-charging registry refuses the withdrawal with a clear error', () => {
    expect(
      explainRejection('GeneralError: transfer: sender spent a different amount than the transfer'),
    ).toMatchObject({ code: 'REGISTRY_FEE', status: 409, message: expect.stringMatching(/fee/) })
  })
})
