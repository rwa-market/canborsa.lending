/** Council: who can do what and which intent gets signed (lending-governance 0.4.0). */
import type {
  CouncilRotationView,
  GovernanceProposalView,
  GovernanceView,
  IncomeProposalView,
} from '@lending/shared'
import { describe, expect, it } from 'vitest'
import {
  delayNote,
  accessOf,
  approvalsWord,
  actionIntent,
  changeRows,
  decmanState,
  incomeActions,
  missingJoins,
  patchesOf,
  proposalActions,
  proposalState,
  rotationActions,
  rotationState,
  suspiciousValue,
  trimDecimal,
} from './model.ts'

const A = 'alice::1220aaaa'
const B = 'bob::1220bbbb'
const C = 'carol::1220cccc'
const D = 'dave::1220dddd'
const OP = 'operator::1220eeee'
const T = 'treasury::1220ffff'
const NOW = new Date('2026-10-01T12:00:00Z')
const LATER = '2026-10-03T12:00:00Z'
const PAST = '2026-09-30T12:00:00Z'

const roles = {
  operator: OP,
  oracle: 'oracle::1220abab',
  guardian: 'guardian::1220acac',
  treasury: T,
  backstop: 'backstop::1220adad',
  liquidators: ['liq::1220aeae'],
}

const proposal = (over: Partial<GovernanceProposalView> = {}): GovernanceProposalView => ({
  contractId: 'p1',
  proposalId: 'params-1',
  description: '',
  proposer: A,
  expiresAt: LATER,
  executableAfter: null,
  approvals: [A],
  threshold: 2,
  trusted: false,
  newRoles: null,
  changes: [],
  ...over,
})
const rotation = (over: Partial<CouncilRotationView> = {}): CouncilRotationView => ({
  contractId: 'r1',
  rotationId: 'council-1',
  proposer: A,
  members: [A, B, C],
  newMembers: [A, B, D],
  newThreshold: 2,
  threshold: 2,
  expiresAt: LATER,
  approvals: [A],
  joined: [],
  formation: false,
  ...over,
})
const income = (over: Partial<IncomeProposalView> = {}): IncomeProposalView => ({
  contractId: 'i1',
  proposalId: 'income-1',
  proposer: A,
  treasury: T,
  reservesAmount: '50.0000000000',
  expiresAt: LATER,
  approvals: [A],
  threshold: 2,
  ...over,
})
const view = (over: Partial<GovernanceView> = {}): GovernanceView => ({
  council: { contractId: 'council-1', members: [A, B, C], threshold: 2 },
  decman: null,
  roles,
  proposals: [],
  rotations: [],
  income: [],
  ...over,
})

const names = (xs: { action: string }[]) => xs.map((x) => x.action)

describe('council proposals', () => {
  it('a member approves once; execute appears exactly at the threshold', () => {
    const v = view()
    expect(names(proposalActions(proposal(), v, B, NOW))).toEqual(['approve'])
    expect(names(proposalActions(proposal(), v, A, NOW))).toEqual(['withdraw'])
    const two = proposal({ approvals: [A, B] })
    expect(proposalState(two, v, NOW).tone).toBe('ready')
    expect(names(proposalActions(two, v, B, NOW))).toEqual(['execute'])
    expect(names(proposalActions(two, v, C, NOW))).toEqual(['approve', 'execute'])
  })

  it('risk 9: a lower liquidation factor executes only from executableAfter', () => {
    const at = '2026-10-01T12:00:01Z'
    const p = proposal({ approvals: [A, B], executableAfter: at })
    expect(proposalState(p, view(), NOW).label).toMatch(/2-day delay/)
    expect(names(proposalActions(p, view(), B, NOW))).not.toContain('execute')
    expect(names(proposalActions(p, view(), B, new Date(at)))).toEqual(['execute'])
  })

  it('a role change is never executed by a member: the operator executes it', () => {
    const p = proposal({ approvals: [A, B], trusted: true, newRoles: roles })
    expect(proposalState(p, view(), NOW).label).toMatch(/operator executes/)
    expect(names(proposalActions(p, view(), B, NOW))).not.toContain('execute')
  })

  it('an expired proposal can only be withdrawn by its proposer', () => {
    const p = proposal({ expiresAt: PAST, approvals: [A, B] })
    expect(proposalState(p, view(), NOW).label).toBe('Expired')
    expect(names(proposalActions(p, view(), B, NOW))).toEqual([])
    expect(names(proposalActions(p, view(), A, NOW))).toEqual(['withdraw'])
  })

  it('outsiders, the treasury and the operator see no actions', () => {
    for (const me of [D, T, OP, null])
      expect(proposalActions(proposal({ approvals: [A, B] }), view(), me, NOW)).toEqual([])
  })
})

describe('council rotation', () => {
  it('the old council approves, a new member joins, execute waits for every join', () => {
    const v = view()
    expect(names(rotationActions(rotation(), v, B, NOW))).toEqual(['approve'])
    expect(names(rotationActions(rotation(), v, D, NOW))).toEqual(['join'])
    const approved = rotation({ approvals: [A, B] })
    expect(rotationState(approved, v, NOW).label).toBe('Waiting for 1 new member to join')
    expect(names(rotationActions(approved, v, B, NOW))).toEqual([])
    const joined = rotation({ approvals: [A, B], joined: [D] })
    expect(missingJoins(joined)).toEqual([])
    expect(rotationState(joined, v, NOW).tone).toBe('ready')
    expect(names(rotationActions(joined, v, B, NOW))).toEqual(['execute'])
    // a new member cannot execute: the controller is the old council or the operator
    expect(names(rotationActions(joined, v, D, NOW))).toEqual([])
  })

  it('forming the first council: joins only, the operator executes', () => {
    const r = rotation({ members: [], newMembers: [A, B], approvals: [], formation: true })
    const v = view({ council: null })
    expect(rotationState(r, v, NOW).label).toBe('Waiting for 2 new members to join')
    expect(names(rotationActions(r, v, A, NOW))).toEqual(['join', 'withdraw'])
    const all = { ...r, joined: [A, B] }
    expect(rotationState(all, v, NOW).label).toMatch(/operator executes/)
    expect(names(rotationActions(all, v, A, NOW))).toEqual(['withdraw'])
  })
})

describe('protocol income', () => {
  it('members approve; only the treasury in the config receives it', () => {
    const v = view()
    expect(names(incomeActions(income(), v, B, NOW))).toEqual(['approve'])
    expect(names(incomeActions(income(), v, T, NOW))).toEqual([])
    const ready = income({ approvals: [A, B] })
    expect(names(incomeActions(ready, v, T, NOW))).toEqual(['execute'])
    // the proposal's treasury changed in the config: cannot execute
    expect(names(incomeActions(ready, view({ roles: { ...roles, treasury: D } }), T, NOW))).toEqual(
      [],
    )
  })
})

describe('access and intents', () => {
  it('knows who is who', () => {
    const v = view({ rotations: [rotation()] })
    expect(accessOf(v, A)).toMatchObject({ member: true, incoming: false })
    expect(accessOf(v, D)).toMatchObject({ member: false, incoming: true })
    expect(accessOf(v, T)).toMatchObject({ treasury: true, member: false })
    expect(accessOf(v, OP)).toMatchObject({ operator: true })
  })

  it('maps each action to the intent the verifier checks', () => {
    expect(actionIntent('rotations', 'join', 'r1', T)).toEqual({
      kind: 'rotation-join',
      rotationCid: 'r1',
    })
    expect(actionIntent('income', 'execute', 'i1', T)).toEqual({
      kind: 'income-execute',
      incomeCid: 'i1',
      treasury: T,
    })
    expect(() => actionIntent('income', 'join', 'i1', T)).toThrow(/unknown governance action/)
  })

  it('splits form changes into protocol and market patches, refusing a repeated field', () => {
    expect(
      patchesOf([
        { scope: 'protocol', field: 'minLoan', value: '50' },
        { scope: 'CC', field: 'borrowCollateralFactor', value: '0.4' },
        { scope: 'CC', field: 'liquidationFactor', value: '0.95' },
      ]),
    ).toEqual({
      paramsPatch: { minLoan: '50' },
      marketParamsPatch: { CC: { borrowCollateralFactor: '0.4', liquidationFactor: '0.95' } },
    })
    expect(() =>
      patchesOf([
        { scope: 'CBTC', field: 'supplyCap', value: '4' },
        { scope: 'CBTC', field: 'supplyCap', value: '5' },
      ]),
    ).toThrow(/CBTC supplyCap is changed twice/)
  })
})

describe('proposal changes: current → proposed', () => {
  it('labels protocol, market, role, factory and Featured App changes', () => {
    const rows = changeRows([
      { scope: 'protocol', target: null, field: 'minLoan', from: '100.0000000000', to: '250.5' },
      {
        scope: 'protocol',
        target: null,
        field: 'rateModel.slope1',
        from: '0.0800000000',
        to: '0.1',
      },
      {
        scope: 'market',
        target: 'CBTC',
        field: 'borrowCollateralFactor',
        from: '0.7000000000',
        to: '0.65',
      },
      {
        scope: 'market',
        target: 'CC',
        field: 'liquidateCollateralFactor',
        from: '0.83',
        to: '0.8',
      },
      { scope: 'protocol', target: null, field: 'targetReserves', from: '50000', to: '60000' },
      { scope: 'market', target: 'XRP', field: '', from: null, to: '{"supplyCap":"5"}' },
      { scope: 'roles', target: null, field: 'guardian', from: roles.guardian, to: D },
      { scope: 'factories', target: 'reg::1220ab::USDCx', field: '', from: 'f1', to: 'f2' },
      { scope: 'featuredAppRight', target: null, field: '', from: 'right-1', to: null },
    ])
    expect(rows.map((r) => [r.label, r.from, r.to, r.parties])).toEqual([
      ['Minimum loan, USDCx', '100', '250.5', false],
      ['Rate model: slope up to the optimal utilization', '0.08', '0.1', false],
      ['CBTC: Collateral Factor', '0.7', '0.65', false],
      ['CC: Liquidation Factor', '0.83', '0.8', false],
      ['Target reserves, USDCx', '50000', '60000', false],
      ['XRP: new market', null, '{"supplyCap":"5"}', false],
      ['Guardian', roles.guardian, D, true],
      ['Transfer factory USDCx', 'f1', 'f2', true],
      ['Featured App right', 'right-1', null, true],
    ])
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  it('trims decimals as strings, without Number', () => {
    expect(trimDecimal('1.2300000000')).toBe('1.23')
    expect(trimDecimal('25000.0000000000')).toBe('25000')
    expect(trimDecimal('123456789012345678.000000000000000001')).toBe(
      '123456789012345678.000000000000000001',
    )
    expect(trimDecimal('100')).toBe('100')
    expect(trimDecimal(null)).toBeNull()
  })

  it('the proposal threshold from the API wins over the council threshold', () => {
    const v = view()
    expect(proposalState(proposal({ threshold: 3, approvals: [A, B] }), v, NOW).label).toBe(
      '2 of 3 approvals',
    )
  })
})

describe('suspicious parameter values', () => {
  it('a credited share typed as the penalty is flagged; a real share is not', () => {
    expect(suspiciousValue('liquidationFactor', '0.07')).toMatch(/not the penalty/)
    expect(suspiciousValue('liquidationFactor', '0.49')).toMatch(/not the penalty/)
    expect(suspiciousValue('liquidationFactor', '0.93')).toBeNull()
    expect(suspiciousValue('borrowCollateralFactor', '0.07')).toBeNull()
  })
})

describe('fields that wait 2 days (review item 33)', () => {
  it('the Liquidation Factor and the credited share say so; the Collateral Factor does not', () => {
    expect(delayNote('liquidateCollateralFactor')).toMatch(/2 days/)
    expect(delayNote('liquidationFactor')).toMatch(/2 days/)
    expect(delayNote('borrowCollateralFactor')).toBeNull()
    expect(delayNote('minLoan')).toBeNull()
  })
})

describe('BitSafe DecMan council (review item 25)', () => {
  const DP = 'council::1220abcd'
  const v = view({
    council: { contractId: 'council-1', members: [DP], threshold: 1 },
    decman: { governanceParty: DP, members: [A, B, C], threshold: 2, actions: [] },
  })

  it('a DecMan member is recognised but is not a council member: votes happen in DecMan', () => {
    expect(accessOf(v, A)).toMatchObject({ decman: true, member: false })
    expect(accessOf(v, D)).toMatchObject({ decman: false })
    expect(proposalActions(proposal({ proposer: DP, approvals: [DP] }), v, A, NOW)).toEqual([])
  })

  it('confirmations count to the DecMan threshold, exactly at the threshold it is ready', () => {
    expect(decmanState(1, 2)).toEqual({ label: '1 of 2 confirmations', tone: 'wait' })
    expect(decmanState(2, 2).tone).toBe('ready')
  })

  it('one approval, two approvals', () => {
    expect(approvalsWord(1)).toBe('approval')
    expect(approvalsWord(2)).toBe('approvals')
  })
})
