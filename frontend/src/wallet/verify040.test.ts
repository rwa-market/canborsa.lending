/** Checking lending-governance-v2 commands before signing (F-1, seam 8) and rejection texts. */
import type { PreparedCommand } from '@lending/shared'
import { describe, expect, it } from 'vitest'
import { explainError } from '../lib/errors.ts'
import {
  CommandRejected,
  type Intent,
  TEMPLATES,
  type VerifyContext,
  verifyPrepared,
} from './verify.ts'

const ALICE = 'alice::1220aaaaaaaaaaaaaaaa'
const MALLORY = 'mallory::1220bbbbbbbbbbbbbbbb'
const OPERATOR = 'operator::1220cccccccccccccccc'
const TREASURY = 'treasury::1220dddddddddddddddd'
const NOW = new Date('2026-09-30T12:00:00Z')
const ctx = { party: ALICE, operator: OPERATOR, accountCid: 'acc-1', now: NOW }

const disclosed = (contractId: string, entity: string) => ({
  templateId: `abc123:${entity}`,
  contractId,
  createdEventBlob: 'blob',
  synchronizerId: 'sync::1',
})
const pool = disclosed('pool-1', 'Lending.Pool:Pool')
const config = disclosed('config-1', 'Lending.Config:ProtocolConfig')

function exercise(
  templateId: string,
  contractId: string,
  choice: string,
  choiceArgument: Record<string, unknown>,
  disclosedContracts: unknown[] = [],
  actAs = [ALICE],
): PreparedCommand {
  return {
    actAs,
    commands: [{ ExerciseCommand: { templateId, contractId, choice, choiceArgument } }],
    disclosedContracts,
    seal: 'seal',
  }
}

const rejects = (p: PreparedCommand, intent: Intent, reason: RegExp, c: VerifyContext = ctx) =>
  expect(() => verifyPrepared(p, intent, c)).toThrow(reason)

describe('governance commands (lending-governance-v2)', () => {
  const roles = {
    operator: OPERATOR,
    oracle: 'oracle2::1220eeee',
    guardian: 'guardian::1220ffff',
    treasury: TREASURY,
    backstop: 'backstop::1220aaab',
    liquidators: ['liq::1220aaac'],
  }
  const propose = (over: Record<string, unknown> = {}) =>
    exercise(
      TEMPLATES.council,
      'council-1',
      'Council_Propose',
      {
        proposer: ALICE,
        proposalId: 'roles-1',
        description: 'rotate the oracle',
        configCid: 'config-1',
        newParams: { minLoan: '10.0000000000', targetReserves: '50000' },
        newMarketParams: [
          ['CC', { borrowCollateralFactor: '0.5', liquidateCollateralFactor: '0.6' }],
        ],
        newTransferFactories: null,
        expiresAt: '2026-10-01T12:00:00Z',
        featuredAppRightChange: null,
        newRoles: roles,
        ...over,
      },
      [config],
    )
  const proposeIntent: Extract<Intent, { kind: 'council-propose' }> = {
    kind: 'council-propose',
    councilCid: 'council-1',
    proposalId: 'roles-1',
    description: 'rotate the oracle',
    expiresAt: '2026-10-01T12:00:00.000Z',
    paramsPatch: {},
    marketParamsPatch: {},
    newRoles: roles,
  }
  /** Current config from the council member's wallet ledger */
  const walletConfig = {
    contractId: 'config-1',
    params: { minLoan: '10', targetReserves: '50000.0000000000' },
    marketParams: [['CC', { borrowCollateralFactor: '0.5', liquidateCollateralFactor: '0.6' }]],
  }
  const withConfig = { ...ctx, config: walletConfig }

  it('Council_Propose: the roles must be exactly the chosen ones, no factory change', () => {
    expect(verifyPrepared(propose(), proposeIntent, ctx).lines.join(' ')).toMatch(
      /needs the operator/,
    )
    rejects(propose({ newRoles: { ...roles, treasury: MALLORY } }), proposeIntent, /roles differ/)
    rejects(propose({ newTransferFactories: [] }), proposeIntent, /transfer factories/)
    rejects(propose({ proposer: MALLORY }), proposeIntent, /another party/)
    expect(() =>
      verifyPrepared(propose({ newRoles: null }), { ...proposeIntent, newRoles: null }, ctx),
    ).not.toThrow()
    rejects(propose(), { ...proposeIntent, newRoles: null }, /changes roles/)
    rejects(
      propose({ newRoles: { ...roles, operator: MALLORY } }),
      { ...proposeIntent, newRoles: { ...roles, operator: MALLORY } },
      /operator cannot change/,
    )
  })

  it('Council_Propose: expiry, description and the disclosed config as chosen', () => {
    rejects(propose({ description: 'other' }), proposeIntent, /description differs/)
    rejects(propose({ expiresAt: '2026-12-01T12:00:00Z' }), proposeIntent, /expiry differs/)
    rejects(
      exercise(TEMPLATES.council, 'council-1', 'Council_Propose', {
        ...(propose().commands[0] as { ExerciseCommand: { choiceArgument: object } })
          .ExerciseCommand.choiceArgument,
      }),
      proposeIntent,
      /protocol config is not among the disclosed/,
    )
  })

  it('Council_Propose: the rate model by rateModel.<field> (review 03.10, item 16)', () => {
    const rm = { baseRate: '0.02', slope1: '0.08', slope2: '0.6', maxUtilization: '0.8' }
    const config = {
      ...walletConfig,
      params: { ...walletConfig.params, rateModel: rm },
    }
    const intent = {
      ...proposeIntent,
      newRoles: null,
      paramsPatch: { 'rateModel.slope1': '0.1' },
      marketParamsPatch: {},
    }
    const cmd = (rateModel: object) =>
      propose({
        newRoles: null,
        newParams: { ...config.params, rateModel },
        newMarketParams: config.marketParams,
      })
    const s = verifyPrepared(cmd({ ...rm, slope1: '0.1' }), intent, { ...ctx, config })
    expect(s.lines.join(' ')).toContain('Rate model: slope up to the optimal utilization → 0.1')
    rejects(
      cmd({ ...rm, slope1: '0.1', maxUtilization: '1' }),
      intent,
      /also changes Utilization ceiling/,
      { ...ctx, config },
    )
    rejects(cmd({ ...rm, slope1: '0.2' }), intent, /differs from the 0.1 you entered/, {
      ...ctx,
      config,
    })
  })

  it('Council_Propose: only the entered parameters change (checked against the wallet config)', () => {
    const intent = {
      ...proposeIntent,
      newRoles: null,
      paramsPatch: { minLoan: '50' },
      marketParamsPatch: { CC: { borrowCollateralFactor: '0.4' } },
    }
    const cmd = (params: object, markets: unknown) =>
      propose({ newRoles: null, newParams: params, newMarketParams: markets })
    const good = cmd({ minLoan: '50', targetReserves: '50000' }, [
      ['CC', { borrowCollateralFactor: '0.4', liquidateCollateralFactor: '0.6' }],
    ])
    const lines = verifyPrepared(good, intent, withConfig).lines.join(' ')
    expect(lines).toContain('Minimum loan, USDCx → 50')
    expect(lines).toContain('CC Collateral Factor → 0.4')
    expect(lines).toMatch(/matches the protocol config in your wallet/)
    // a change the council member did not enter
    rejects(
      cmd({ minLoan: '50', targetReserves: '1' }, [
        ['CC', { borrowCollateralFactor: '0.4', liquidateCollateralFactor: '0.6' }],
      ]),
      intent,
      /also changes Target reserves, USDCx/,
      withConfig,
    )
    rejects(
      cmd({ minLoan: '50', targetReserves: '50000' }, [
        ['CC', { borrowCollateralFactor: '0.4', liquidateCollateralFactor: '0.9' }],
      ]),
      intent,
      /also changes CC Liquidation Factor/,
      withConfig,
    )
    rejects(
      cmd({ minLoan: '50', targetReserves: '50000' }, [
        ['CC', { borrowCollateralFactor: '0.4', liquidateCollateralFactor: '0.6' }],
        ['XRP', { borrowCollateralFactor: '0.9' }],
      ]),
      intent,
      /set of markets/,
      withConfig,
    )
    rejects(
      cmd({ minLoan: '51', targetReserves: '50000' }, [
        ['CC', { borrowCollateralFactor: '0.4', liquidateCollateralFactor: '0.6' }],
      ]),
      intent,
      /Minimum loan, USDCx in the proposal differs from the 50/,
    )
    rejects(good, intent, /another protocol config/, {
      ...ctx,
      config: { ...walletConfig, contractId: 'config-0' },
    })
    // demo wallet: no config, only the entered fields are checked, and this is stated
    expect(verifyPrepared(good, intent, ctx).lines.join(' ')).toMatch(/not checked/)
  })

  it('approve / execute / withdraw target the chosen proposal', () => {
    const approve = exercise(TEMPLATES.proposal, 'prop-1', 'Proposal_Approve', { approver: ALICE })
    expect(() =>
      verifyPrepared(approve, { kind: 'proposal-approve', proposalCid: 'prop-1' }, ctx),
    ).not.toThrow()
    rejects(approve, { kind: 'proposal-approve', proposalCid: 'prop-2' }, /another contract/)
    rejects(
      exercise(TEMPLATES.proposal, 'prop-1', 'Proposal_ExecuteTrusted', { configCid: 'config-1' }),
      { kind: 'proposal-execute', proposalCid: 'prop-1' },
      /expected Proposal_Execute/,
    )
    const execute = exercise(
      TEMPLATES.proposal,
      'prop-1',
      'Proposal_Execute',
      { executor: ALICE, configCid: 'config-1' },
      [config],
    )
    expect(() =>
      verifyPrepared(execute, { kind: 'proposal-execute', proposalCid: 'prop-1' }, ctx),
    ).not.toThrow()
  })

  it('approve / execute: the signed contract is the one on the card, changes are not trusted', () => {
    // The card shows prop-1 (and its changes from the API), the server swapped in prop-2
    const approve2 = exercise(TEMPLATES.proposal, 'prop-2', 'Proposal_Approve', { approver: ALICE })
    rejects(approve2, { kind: 'proposal-approve', proposalCid: 'prop-1' }, /another contract/)
    const execute2 = exercise(
      TEMPLATES.proposal,
      'prop-2',
      'Proposal_Execute',
      { executor: ALICE, configCid: 'config-1' },
      [config],
    )
    rejects(execute2, { kind: 'proposal-execute', proposalCid: 'prop-1' }, /another contract/)
    // The signing summary names the card's contract
    const approve = exercise(TEMPLATES.proposal, 'prop-1', 'Proposal_Approve', { approver: ALICE })
    const s = verifyPrepared(approve, { kind: 'proposal-approve', proposalCid: 'prop-1' }, ctx)
    expect(s.lines[0]).toBe('Proposal contract prop-1')
    // An extra field in the choice (e.g. other parameters) does not pass
    rejects(
      exercise(TEMPLATES.proposal, 'prop-1', 'Proposal_Approve', {
        approver: ALICE,
        newParams: { minLoan: '1' },
      }),
      { kind: 'proposal-approve', proposalCid: 'prop-1' },
      /unexpected field "newParams"/,
    )
  })

  it('rotation: members and threshold as chosen, execute discloses pool and config', () => {
    const intent: Intent = {
      kind: 'rotation-propose',
      councilCid: 'council-1',
      rotationId: 'r1',
      newMembers: [ALICE, 'bob::1220abab'],
      newThreshold: 2,
      expiresAt: '2026-10-01T12:00:00Z',
    }
    const cmd = (over: Record<string, unknown> = {}) =>
      exercise(TEMPLATES.council, 'council-1', 'Council_ProposeRotation', {
        proposer: ALICE,
        rotationId: 'r1',
        newMembers: [ALICE, 'bob::1220abab'],
        newThreshold: '2',
        expiresAt: '2026-10-01T12:00:00Z',
        ...over,
      })
    expect(() => verifyPrepared(cmd(), intent, ctx)).not.toThrow()
    rejects(cmd({ newMembers: [ALICE, MALLORY] }), intent, /new members differ/)
    rejects(cmd({ newThreshold: '1' }), intent, /threshold differs/)
    rejects(cmd({ expiresAt: '2027-10-01T12:00:00Z' }), intent, /expiry differs/)
    const join = exercise(TEMPLATES.rotation, 'rot-1', 'Rotation_Join', { joiner: ALICE })
    expect(() =>
      verifyPrepared(join, { kind: 'rotation-join', rotationCid: 'rot-1' }, ctx),
    ).not.toThrow()
    rejects(
      exercise(TEMPLATES.rotation, 'rot-1', 'Rotation_Join', { joiner: MALLORY }),
      { kind: 'rotation-join', rotationCid: 'rot-1' },
      /another party/,
    )
    const exec = (d: unknown[]) =>
      exercise(
        TEMPLATES.rotation,
        'rot-1',
        'Rotation_Execute',
        { executor: ALICE, councilCid: 'council-1', configCid: 'config-1', poolCid: 'pool-1' },
        d,
      )
    expect(() =>
      verifyPrepared(exec([config, pool]), { kind: 'rotation-execute', rotationCid: 'rot-1' }, ctx),
    ).not.toThrow()
    rejects(exec([config]), { kind: 'rotation-execute', rotationCid: 'rot-1' }, /the pool is not/)
  })

  it('income: reserves only, and only to the treasury', () => {
    const intent: Intent = {
      kind: 'income-propose',
      councilCid: 'council-1',
      proposalId: 'i1',
      treasury: TREASURY,
      reservesAmount: '50',
    }
    const cmd = (over: Record<string, unknown> = {}) =>
      exercise(TEMPLATES.council, 'council-1', 'Council_ProposeIncome', {
        proposer: ALICE,
        proposalId: 'i1',
        treasury: TREASURY,
        reservesAmount: '50',
        expiresAt: '2026-10-01T12:00:00Z',
        ...over,
      })
    expect(verifyPrepared(cmd(), intent, ctx).lines.join(' ')).toContain('50 USDCx of reserves')
    rejects(cmd({ treasury: MALLORY }), intent, /not the treasury/)
    rejects(cmd({ reservesAmount: '5000' }), intent, /reserves amount 5000 differs/)
    // the old collateral payout is not a field of Council_ProposeIncome any more
    rejects(cmd({ collateral: [{ _1: 'CC', _2: '20' }] }), intent, /unexpected field "collateral"/)

    const tctx = { ...ctx, party: TREASURY }
    const exec = (d: unknown[], over: Record<string, unknown> = {}) =>
      exercise(
        TEMPLATES.income,
        'inc-1',
        'IncomeProposal_Execute',
        {
          poolCid: 'pool-1',
          configCid: 'config-1',
          reservesPayout: { factoryCid: 'f', inputHoldingCids: [] },
          ...over,
        },
        d,
        [TREASURY],
      )
    const execIntent: Intent = { kind: 'income-execute', incomeCid: 'inc-1', treasury: TREASURY }
    expect(() => verifyPrepared(exec([pool, config]), execIntent, tctx)).not.toThrow()
    rejects(exec([config]), execIntent, /the pool is not/, tctx)
    rejects(
      exec([pool, config], { collateralPayouts: [{ _1: 'CC', _2: {} }] }),
      execIntent,
      /unexpected field "collateralPayouts"/,
      tctx,
    )
    expect(() => verifyPrepared(exec([pool, config]), execIntent, ctx)).toThrow(CommandRejected)
  })
})

describe('lending-core-v2 rejections are explained', () => {
  it.each([
    [
      'GeneralError: reserves are negative: withdrawals and loans wait for recapitalization',
      /protocol reserves are negative/,
    ],
    ['withdrawal exceeds the deposit: borrow explicitly', /never borrows: use Borrow/],
    ['debt asset depegged: new borrowing paused', /USDCx price is too far/],
    ['borrowing paused', /guardian has paused/],
    ['deposit withdrawals paused', /guardian has paused/],
    ['collateral purchase paused', /guardian has paused/],
    ['debt exceeds the repay bound: raise amount', /grew past the amount you signed/],
    ['price feed: wrong oracle', /oracle was rotated/],
    ['price feed: stale price', /Prices are not valid/],
  ])('%s', (msg, want) => {
    expect(explainError(msg)).toMatch(want)
  })
  it('uses the backend code when the text is already explained', () => {
    expect(explainError('whatever', 'WITHDRAWALS_WAIT_FOR_RECAPITALIZATION')).toMatch(
      /reserves are negative/,
    )
    expect(explainError('not enough collateral for the loan')).toBeNull()
  })
})
