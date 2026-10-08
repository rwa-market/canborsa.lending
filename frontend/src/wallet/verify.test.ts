import type { PreparedCommand } from '@lending/shared'
import { describe, expect, it } from 'vitest'
import { CommandRejected, type Intent, TEMPLATES, verifyPrepared } from './verify.ts'

const ALICE = 'alice::1220aaaaaaaaaaaaaaaa'
const MALLORY = 'mallory::1220bbbbbbbbbbbbbbbb'
const OPERATOR = 'operator::1220cccccccccccccccc'
const NOW = new Date('2026-09-30T12:00:00Z')
const ctx = { party: ALICE, operator: OPERATOR, accountCid: 'acc-1', now: NOW }

const disclosed = (contractId: string, entity: string) => ({
  templateId: `abc123:${entity}`,
  contractId,
  createdEventBlob: 'blob',
  synchronizerId: 'sync::1',
})

const core = [
  disclosed('pool-1', 'Lending.Pool:Pool'),
  disclosed('config-1', 'Lending.Config:ProtocolConfig'),
  disclosed('factory-1', 'Splice.Testing.Tokens.TestTokenV1:TokenRules'),
]
/** Risk-raising operations also disclose the pause flags, the feeds and the attestations */
const risky = [
  ...core,
  disclosed('pause-1', 'Lending.Pause:PauseState'),
  disclosed('feed-cc', 'Lending.Oracle:PriceFeed'),
  disclosed('feed-cbtc', 'Lending.Oracle:PriceFeed'),
  disclosed('feed-usdcx', 'Lending.Oracle:PriceFeed'),
  disclosed('att-1', 'Lending.Oracle:ReserveAttestation'),
]

/** A command in the shape backend/src/protocol/commands.ts builds it */
function poolCommand(choice: string, args: Record<string, unknown>, extra = core): PreparedCommand {
  return {
    actAs: [ALICE],
    commands: [
      {
        ExerciseCommand: {
          templateId: TEMPLATES.pool,
          contractId: 'pool-1',
          choice,
          choiceArgument: { configCid: 'config-1', ...args },
        },
      },
    ],
    disclosedContracts: extra,
    seal: 'seal',
  }
}

const payment = (inputs = ['h1', 'h2']) => ({
  factoryCid: 'factory-1',
  inputHoldingCids: inputs,
  transferExtraArgs: { context: { values: {} }, meta: { values: {} } },
  acceptExtraArgs: { context: { values: {} }, meta: { values: {} } },
})

const prices = {
  collateralFeedCids: ['feed-cc', 'feed-cbtc'],
  debtFeedCid: 'feed-usdcx',
  attestationCids: ['att-1'],
}

const supply = (over: Record<string, unknown> = {}) =>
  poolCommand('Pool_SupplyBase', {
    user: ALICE,
    accountCid: 'acc-1',
    amount: '100',
    full: false,
    payment: payment(),
    ...over,
  })

const withdrawBase = (over: Record<string, unknown> = {}) =>
  poolCommand(
    'Pool_WithdrawBase',
    {
      user: ALICE,
      pauseCid: 'pause-1',
      accountCid: 'acc-1',
      amount: '100',
      full: false,
      allowBorrow: false,
      prices,
      payout: payment(['op-h1']),
      ...over,
    },
    risky,
  )

const supplyIntent: Intent = { kind: 'supply', amount: '100', inputs: ['h1', 'h2', 'h3'] }

const rejects = (p: PreparedCommand, intent: Intent, reason: RegExp, c = ctx) =>
  expect(() => verifyPrepared(p, intent, c)).toThrow(reason)

describe('verifyPrepared: lending-core-v2 template ids', () => {
  it('pins the new package names', () => {
    expect(TEMPLATES.pool).toBe('#lending-core-v2:Lending.Pool:Pool')
    expect(TEMPLATES.pauseState).toBe('#lending-core-v2:Lending.Pause:PauseState')
    expect(TEMPLATES.income).toBe('#lending-governance-v2:Lending.Governance:IncomeProposal')
  })
})

describe('verifyPrepared: supply (Pool_SupplyBase)', () => {
  it('accepts the command the backend builds and describes it', () => {
    const s = verifyPrepared(supply(), supplyIntent, ctx)
    expect(s.title).toBe('Supply 100 USDCx')
    expect(s.lines.join(' ')).toContain('operator::1220cccc')
    expect(s.lines.join(' ')).toMatch(/debt is repaid first/)
  })

  it('accepts an equal amount written differently', () => {
    expect(() =>
      verifyPrepared(supply({ amount: '100.0000000000' }), supplyIntent, ctx),
    ).not.toThrow()
  })

  it('refuses another amount', () => {
    rejects(supply({ amount: '1000' }), supplyIntent, /amount 1000 differs from the 100/)
    rejects(supply({ amount: '100.0000000001' }), supplyIntent, /differs/)
  })

  it('refuses the full flag on a typed amount and a missing flag', () => {
    rejects(supply({ full: true }), supplyIntent, /takes everything/)
    rejects(supply({ full: undefined }), supplyIntent, /takes everything/)
  })

  it('refuses a command for another user', () => {
    rejects(supply({ user: MALLORY }), supplyIntent, /another user/)
  })

  it('refuses acting as another party', () => {
    rejects({ ...supply(), actAs: [MALLORY] }, supplyIntent, /acts for another party/)
    rejects({ ...supply(), actAs: [ALICE, MALLORY] }, supplyIntent, /acts for another party/)
  })

  it('refuses holdings the app did not select', () => {
    rejects(supply({ payment: payment(['h1', 'stolen']) }), supplyIntent, /did not select/)
  })

  it('refuses another account', () => {
    rejects(supply({ accountCid: 'acc-evil' }), supplyIntent, /another account/)
  })

  it('refuses a factory that is not disclosed', () => {
    rejects(
      supply({ payment: { ...payment(), factoryCid: 'factory-evil' } }),
      supplyIntent,
      /factory is not disclosed/,
    )
  })

  it('refuses an extra command', () => {
    const p = supply()
    rejects({ ...p, commands: [...p.commands, ...p.commands] }, supplyIntent, /exactly one/)
  })

  it('refuses a direct token transfer instead of the pool choice', () => {
    const p: PreparedCommand = {
      actAs: [ALICE],
      commands: [
        {
          ExerciseCommand: {
            templateId:
              '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
            contractId: 'factory-1',
            choice: 'TransferFactory_Transfer',
            choiceArgument: { expectedAdmin: OPERATOR, transfer: { receiver: MALLORY } },
          },
        },
      ],
      disclosedContracts: core,
      seal: 's',
    }
    rejects(p, supplyIntent, /unknown template/)
  })

  it('refuses the old lending-core package and another choice on the pool', () => {
    const p = supply()
    const old = structuredClone(p)
    ;(old.commands[0] as { ExerciseCommand: { templateId: string } }).ExerciseCommand.templateId =
      '#lending-core:Lending.Pool:Pool'
    rejects(old, supplyIntent, /unknown template/)
    rejects(withdrawBase(), supplyIntent, /expected Pool_SupplyBase, got Pool_WithdrawBase/)
    rejects(
      poolCommand('Pool_Supply', { user: ALICE, accountCid: 'acc-1', amount: '100' }),
      supplyIntent,
      /expected Pool_SupplyBase, got Pool_Supply/,
    )
  })

  it('refuses a pool contract that is not disclosed as a pool', () => {
    const p = supply()
    rejects({ ...p, disclosedContracts: core.slice(1) }, supplyIntent, /pool is not among/)
    rejects(
      { ...p, disclosedContracts: [disclosed('pool-1', 'Evil:Pool'), ...core.slice(1)] },
      supplyIntent,
      /pool has a wrong template/,
    )
  })

  it('refuses unknown non-empty fields, tolerates new empty Optional ones', () => {
    rejects(supply({ receiver: MALLORY }), supplyIntent, /unexpected field "receiver"/)
    expect(() => verifyPrepared(supply({ memo: null }), supplyIntent, ctx)).not.toThrow()
  })

  it('throws CommandRejected, so callers can tell it from wallet errors', () => {
    expect(() => verifyPrepared(supply({ amount: '1' }), supplyIntent, ctx)).toThrow(
      CommandRejected,
    )
  })
})

describe('verifyPrepared: repay is a supply that pays the debt (K2)', () => {
  const all: Intent = { kind: 'repay', amount: 'max', debt: '500', inputs: ['h1', 'h2'] }
  const repayAll = (amount: string, full: unknown = true) => supply({ amount, full })

  it('typed repayment: Pool_SupplyBase with full = False and the exact amount', () => {
    const typed: Intent = { kind: 'repay', amount: '100' }
    expect(verifyPrepared(supply(), typed, ctx).title).toBe('Repay 100 USDCx')
    rejects(supply({ full: true }), typed, /takes everything/)
  })

  it('accepts repay-all with full = true and the backend cap', () => {
    const s = verifyPrepared(repayAll('500.5000000001'), all, ctx)
    expect(s.title).toBe('Repay the whole debt, up to 500.5000000001 USDCx')
    expect(s.lines.join(' ')).toContain('your debt is 500 USDCx now')
  })

  it('accepts the cap exactly at debt + 0.2% + one token step, refuses one step more', () => {
    expect(() => verifyPrepared(repayAll('501.0000000001'), all, ctx)).not.toThrow()
    rejects(repayAll('501.0000000002'), all, /more than your debt 500 plus 0.2%/)
  })

  it('accepts the cap exactly at the debt, refuses one step below', () => {
    expect(() => verifyPrepared(repayAll('500'), all, ctx)).not.toThrow()
    rejects(repayAll('499.9999999999'), all, /less than your debt/)
  })

  it('refuses repay-all without the flag or with unknown debt', () => {
    rejects(repayAll('500.5', false), all, /not marked "repay all"/)
    rejects(repayAll('500.5', 'true'), all, /not marked "repay all"/)
    rejects(repayAll('500.5'), { ...all, debt: undefined } as Intent, /debt is unknown/)
  })

  it('a plain supply never takes "all"', () => {
    rejects(
      repayAll('500'),
      { kind: 'supply', amount: 'max' } as unknown as Intent,
      /only a repayment/,
    )
  })
})

describe('verifyPrepared: withdraw never borrows, borrow is explicit (risk 7)', () => {
  const withdraw: Intent = { kind: 'withdraw', amount: '100', balance: '500' }
  const borrow: Intent = { kind: 'borrow', amount: '100' }

  it('withdraw: allowBorrow = False, the exact amount, the pause flags and prices disclosed', () => {
    const s = verifyPrepared(withdrawBase(), withdraw, ctx)
    expect(s.title).toBe('Withdraw 100 USDCx')
    expect(s.lines.join(' ')).toMatch(/Never borrows/)
  })

  it('withdraw: refuses allowBorrow = True or a missing flag', () => {
    rejects(withdrawBase({ allowBorrow: true }), withdraw, /allowed to borrow/)
    rejects(withdrawBase({ allowBorrow: null }), withdraw, /allowed to borrow/)
  })

  it('withdraw all: full = True, never borrows, amount only has to be positive', () => {
    const all: Intent = { kind: 'withdraw', amount: 'max', balance: '100' }
    const s = verifyPrepared(withdrawBase({ full: true, amount: '100.0000123456' }), all, ctx)
    expect(s.title).toBe('Withdraw your whole supply')
    expect(s.lines.join(' ')).toMatch(/never borrows/)
    rejects(withdrawBase({ full: false }), all, /not marked "withdraw all"/)
    rejects(withdrawBase({ full: true, allowBorrow: true }), all, /allowed to borrow/)
    rejects(withdrawBase({ full: true, amount: '0' }), all, /must be positive/)
  })

  it('a typed withdrawal is not "withdraw all"', () => {
    rejects(withdrawBase({ full: true }), withdraw, /takes everything/)
    rejects(withdrawBase({ amount: '101' }), withdraw, /amount 101 differs from the 100/)
  })

  it('borrow: allowBorrow = True, full = False, the exact amount', () => {
    const p = withdrawBase({ allowBorrow: true })
    const s = verifyPrepared(p, borrow, ctx)
    expect(s.title).toBe('Borrow 100 USDCx')
    expect(s.lines.join(' ')).toMatch(/borrowing allowed/)
    rejects(withdrawBase({ allowBorrow: false }), borrow, /does not allow the loan/)
    rejects(withdrawBase({ allowBorrow: true, full: true }), borrow, /takes everything/)
    rejects(withdrawBase({ allowBorrow: true, amount: '1000' }), borrow, /amount 1000 differs/)
  })

  it('the pause flags must be the disclosed PauseState', () => {
    rejects(withdrawBase({ pauseCid: 'pause-evil' }), withdraw, /pause flags is not among/)
    const p = withdrawBase()
    rejects(
      {
        ...p,
        disclosedContracts: [...core, disclosed('pause-1', 'Evil:PauseState')],
      },
      withdraw,
      /pause flags has a wrong template/,
    )
  })

  it('every price contract is disclosed with its template', () => {
    rejects(
      withdrawBase({ allowBorrow: true, prices: { ...prices, collateralFeedCids: ['feed-evil'] } }),
      borrow,
      /collateral price feed is not among/,
    )
    rejects(
      withdrawBase({ allowBorrow: true, prices: { ...prices, debtFeedCid: 'att-1' } }),
      borrow,
      /USDCx price feed has a wrong template/,
    )
    rejects(
      withdrawBase({ allowBorrow: true, prices: { ...prices, attestationCids: ['feed-cc'] } }),
      borrow,
      /reserve attestation has a wrong template/,
    )
    rejects(
      withdrawBase({ allowBorrow: true, prices: { ...prices, extra: 'x' } }),
      borrow,
      /unexpected field "extra"/,
    )
    expect(() =>
      verifyPrepared(
        withdrawBase({
          allowBorrow: true,
          prices: { collateralFeedCids: [], debtFeedCid: null, attestationCids: [] },
        }),
        borrow,
        ctx,
      ),
    ).not.toThrow()
  })
})

describe('verifyPrepared: collateral', () => {
  it('deposit: Pool_SupplyCollateral, market and amount as entered, no price needed', () => {
    const p = poolCommand('Pool_SupplyCollateral', {
      user: ALICE,
      accountCid: 'acc-1',
      marketId: 'CC',
      amount: '20000',
      payment: payment(),
    })
    const intent: Intent = { kind: 'deposit-collateral', marketId: 'CC', amount: '20000' }
    expect(verifyPrepared(p, intent, ctx).title).toBe('Supply 20000 CC as collateral')
    rejects(p, { ...intent, marketId: 'CBTC' }, /market CC, not CBTC/)
    rejects(p, { ...intent, amount: '2000' }, /differs/)
  })

  it('withdraw: Pool_WithdrawCollateral with pause flags and prices, not more than held', () => {
    const p = (amount: string) =>
      poolCommand(
        'Pool_WithdrawCollateral',
        {
          user: ALICE,
          pauseCid: 'pause-1',
          accountCid: 'acc-1',
          marketId: 'CBTC',
          amount,
          prices,
          payout: payment(['op-h1']),
        },
        risky,
      )
    const intent: Intent = {
      kind: 'withdraw-collateral',
      marketId: 'CBTC',
      amount: '0.1',
      collateral: '0.1',
    }
    expect(verifyPrepared(p('0.1'), intent, ctx).title).toBe('Withdraw 0.1 CBTC')
    rejects(p('0.2'), intent, /differs/)
    rejects(p('0.2'), { ...intent, amount: '0.2' }, /more than you hold/)
  })
})

describe('verifyPrepared: login', () => {
  const NONCE = 'ab'.repeat(30)
  const login = (args: Record<string, unknown> = {}, disclosedContracts: unknown[] = []) => ({
    actAs: [ALICE],
    commands: [
      {
        CreateCommand: {
          templateId: TEMPLATES.login,
          createArguments: {
            user: ALICE,
            operator: OPERATOR,
            nonce: NONCE,
            expiresAt: '2026-09-30T12:05:00.000Z',
            ...args,
          },
        },
      },
    ],
    disclosedContracts,
    seal: 's',
  })
  const intent: Intent = { kind: 'login', nonce: NONCE }

  it('accepts the Login the backend builds and says it moves no funds', () => {
    const s = verifyPrepared(login(), intent, ctx)
    expect(s.title).toBe('Sign in to Canton Lending')
    expect(s.lines.join(' ')).toMatch(/moves no funds/)
  })

  it('refuses another operator, nonce or user', () => {
    rejects(login({ operator: MALLORY }), intent, /unknown operator/)
    rejects(login({ nonce: 'cd'.repeat(30) }), intent, /nonce does not match/)
    rejects(login({ user: MALLORY }), intent, /another party/)
  })

  it('refuses a Login without expiry, expired or living longer than 15 minutes', () => {
    rejects(login({ expiresAt: null }), intent, /no expiry/)
    rejects(login({ expiresAt: '2026-09-30T11:59:00.000Z' }), intent, /already expired/)
    rejects(login({ expiresAt: '2026-09-30T12:30:00.000Z' }), intent, /lives too long/)
  })

  it('refuses disclosed contracts and exercise commands on sign-in', () => {
    rejects(login({}, core), intent, /must not use disclosed/)
    rejects(supply(), intent, /expected a Login/)
  })
})

describe('verifyPrepared: service roles', () => {
  const flags = {
    borrowPaused: true,
    collateralWithdrawPaused: false,
    supplyWithdrawPaused: false,
    absorbPaused: true,
    buyPaused: false,
  }
  const pause = (
    args: Record<string, unknown>,
    d: unknown[] = [],
    choice = 'PauseState_SetFlag',
  ): PreparedCommand => ({
    actAs: [ALICE],
    commands: [
      {
        ExerciseCommand: {
          templateId: TEMPLATES.pauseState,
          contractId: 'pause-1',
          choice,
          choiceArgument: args,
        },
      },
    ],
    disclosedContracts: d,
    seal: 's',
  })

  it('pause: one flag exactly as chosen; the others are never in the command', () => {
    const intent: Intent = { kind: 'pause', flag: 'borrowPaused', paused: true }
    const s = verifyPrepared(pause({ flag: 'BorrowFlag', paused: true }), intent, ctx)
    expect(s.title).toBe('Pause: new loans')
    expect(s.lines).toContain('New loans: paused')
    expect(s.lines).toContain('The other pauses stay as they are')
    rejects(pause({ flag: 'BorrowFlag', paused: false }), intent, /pause differs/)
    rejects(pause({ flag: 'BuyFlag', paused: true }), intent, /pause differs/)
    rejects(
      pause({ flag: 'BorrowFlag', paused: true, newFlags: flags }),
      intent,
      /unexpected field "newFlags"/,
    )
    expect(() =>
      verifyPrepared(
        pause({ flag: 'BorrowFlag', paused: true }, [
          disclosed('pause-1', 'Lending.Pause:PauseState'),
        ]),
        intent,
        ctx,
      ),
    ).not.toThrow()
    rejects(pause({ flag: 'BorrowFlag', paused: true }, core), intent, /discloses other contracts/)
  })

  it('pause: refuses the five-flag choice, the old pool choices and another template', () => {
    const intent: Intent = { kind: 'pause', flag: 'buyPaused', paused: false }
    // PauseState_Set rewrites all five flags from a possibly stale view: never signed by the UI
    rejects(pause({ newFlags: flags }, [], 'PauseState_Set'), intent, /expected PauseState_SetFlag/)
    rejects(poolCommand('Pool_SetPause', { actor: ALICE }), intent, /expected PauseState_SetFlag/)
    const other = pause({ flag: 'BuyFlag', paused: false })
    ;(other.commands[0] as { ExerciseCommand: { templateId: string } }).ExerciseCommand.templateId =
      TEMPLATES.pool
    rejects(other, intent, /expected PauseState_SetFlag/)
  })

  it('add reserves: Pool_AddReserves for the treasury itself and the exact amount', () => {
    const p = (over: Record<string, unknown> = {}) =>
      poolCommand('Pool_AddReserves', { actor: ALICE, amount: '175', payment: payment(), ...over })
    const intent: Intent = { kind: 'add-reserves', amount: '175' }
    expect(verifyPrepared(p(), intent, ctx).title).toBe('Add 175 USDCx to protocol reserves')
    rejects(p({ amount: '176' }), intent, /differs/)
    rejects(p({ actor: MALLORY }), intent, /another party/)
    rejects(
      poolCommand('Pool_FundInsurance', { actor: ALICE }),
      intent,
      /expected Pool_AddReserves/,
    )
  })

  it('buy collateral: exact payment, the minimum not lowered, feeds and pauses disclosed', () => {
    const p = (over: Record<string, unknown> = {}) =>
      poolCommand(
        'Pool_BuyCollateral',
        {
          buyer: ALICE,
          pauseCid: 'pause-1',
          marketId: 'CC',
          amount: '6136',
          minCollateral: '50000',
          collateralFeedCid: 'feed-cc',
          debtFeedCid: 'feed-usdcx',
          payment: payment(),
          payout: payment(['op-cc']),
          ...over,
        },
        risky,
      )
    const intent: Intent = {
      kind: 'buy-collateral',
      marketId: 'CC',
      amount: '6136',
      minCollateral: '50000',
    }
    const s = verifyPrepared(p(), intent, ctx)
    expect(s.title).toBe('Buy CC for 6136 USDCx')
    expect(s.lines.join(' ')).toContain('at least 50000 CC')
    // a higher minimum only protects the buyer more; one unit lower is refused
    expect(() => verifyPrepared(p({ minCollateral: '50001' }), intent, ctx)).not.toThrow()
    rejects(p({ minCollateral: '49999.9999999999' }), intent, /below your 50000/)
    rejects(p({ amount: '6137' }), intent, /differs/)
    rejects(p({ buyer: MALLORY }), intent, /another buyer/)
    rejects(p({ marketId: 'CBTC' }), intent, /market CBTC, not CC/)
    rejects(p({ collateralFeedCid: 'att-1' }), intent, /collateral price has a wrong template/)
    rejects(p({ debtFeedCid: 'feed-evil' }), intent, /USDCx price is not among/)
  })
})
