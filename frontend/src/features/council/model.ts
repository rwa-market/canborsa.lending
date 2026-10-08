/**
 * Council (lending-governance-v2): proposal state, who can do what and which
 * intent gets signed. The contract decides everything; here only which buttons to show
 * and what to check in the command before signing (F-1). Module without React: vitest runs it.
 */
import type {
  CouncilRotationView,
  GovernanceChange,
  GovernanceProposalView,
  GovernanceRolesView,
  GovernanceView,
  IncomeProposalView,
  MarketId,
} from '@lending/shared'
import type { GovernanceAction, GovernanceKind } from '../../lib/api.ts'
import type { Intent } from '../../wallet/verify.ts'

/**
 * Decimal ProtocolParams fields a proposal changes (backend routes: paramsPatch). `rateModel.*` are
 * the interest rate model and the utilization ceiling (review 03.10, item 16).
 */
export const PROTOCOL_FIELDS = [
  ['totalBorrowCap', 'Total borrow cap, USDCx'],
  ['maxDebtPerUser', 'Max debt per user, USDCx'],
  ['minLoan', 'Minimum loan, USDCx'],
  ['targetReserves', 'Target reserves, USDCx'],
  ['storeFrontPriceFactor', 'Buyer share of the liquidation penalty (store front price factor)'],
  ['liquidationRiskWarning', 'Liquidation risk warning'],
  ['maxPriceAgeSeconds', 'Max price age, seconds'],
  ['maxSourceDeviation', 'Max price source deviation'],
  ['maxLiquidationSourceDeviation', 'Max source deviation for liquidation'],
  ['maxDebtDepeg', 'Max USDCx depeg'],
  ['maxClockSkewSeconds', 'Max clock skew, seconds'],
  ['rateModel.baseRate', 'Rate model: borrow APR at 0% utilization'],
  ['rateModel.slope1', 'Rate model: slope up to the optimal utilization'],
  ['rateModel.slope2', 'Rate model: slope above the optimal utilization'],
  ['rateModel.optimalUtilization', 'Rate model: optimal utilization'],
  ['rateModel.maxUtilization', 'Utilization ceiling: new loans stop above it'],
  ['rateModel.reserveFactor', 'Reserve factor: protocol share of the interest'],
] as const

/**
 * Decimal MarketParams fields (marketParamsPatch), Compound's AssetList. Reserve attestation cannot be
 * turned off here.
 */
export const MARKET_FIELDS = [
  // The names of the market page (Compound): Collateral Factor, Liquidation Factor, Liquidation
  // Penalty = 1 − liquidationFactor (review 03.10, item 17)
  ['borrowCollateralFactor', 'Collateral Factor'],
  ['liquidateCollateralFactor', 'Liquidation Factor'],
  ['liquidationFactor', 'Credited share on absorb: 0.93 = a 7% Liquidation Penalty'],
  ['supplyCap', 'Supply cap, asset units'],
  ['minCollateralAmount', 'Minimum collateral deposit, asset units'],
  ['minReserveCoverage', 'Min reserve coverage'],
  ['maxAttestationAgeSeconds', 'Max attestation age, seconds'],
] as const

export type Scope = 'protocol' | MarketId

/** The same format the backend accepts: up to 18 digits and up to 18 decimal places. */
export const PARAM_VALUE = /^\d{1,18}(\.\d{1,18})?$/
const PARTY = /^[\w.-]{1,128}::[0-9a-f]{8,128}$/
export const isParty = (v: string) => PARTY.test(v)

export interface Access {
  member: boolean
  treasury: boolean
  operator: boolean
  /** New member in an open rotation: can join */
  incoming: boolean
  /** Member of the BitSafe Decentralized Party that sits on the council: votes in DecMan */
  decman: boolean
}

export function accessOf(view: GovernanceView, me: string | null): Access {
  return {
    member: !!me && !!view.council?.members.includes(me),
    treasury: !!me && view.roles.treasury === me,
    operator: !!me && view.roles.operator === me,
    incoming:
      !!me && view.rotations.some((r) => r.newMembers.includes(me) && !r.members.includes(me)),
    decman: !!me && !!view.decman?.members.includes(me),
  }
}

/** "1 approval", "2 approvals": the count with the noun in the right number. */
export const approvalsWord = (n: number) => (n === 1 ? 'approval' : 'approvals')

/** "2 of 3 confirmations" for a DecMan action; ready once the threshold is met. */
export function decmanState(
  confirmations: number,
  threshold: number,
): Pick<ItemState, 'label' | 'tone'> {
  return confirmations >= threshold
    ? { label: 'Confirmed, any member executes it in DecMan', tone: 'ready' }
    : { label: `${confirmations} of ${threshold} confirmations`, tone: 'wait' }
}

export type Tone = 'wait' | 'ready' | 'blocked' | 'done'

export interface ItemState {
  label: string
  tone: Tone
  expired: boolean
  /** How many approvals are needed (the threshold of the council the proposal counts against) */
  threshold: number
}

export interface Action {
  action: GovernanceAction
  label: string
}

const expiredAt = (expiresAt: string, now: Date) => Date.parse(expiresAt) <= now.getTime()

/** Proposal threshold: the backend may return it as a field, otherwise the current council's threshold. */
const thresholdOf = (item: object, view: GovernanceView) => {
  const own = (item as { threshold?: unknown }).threshold
  return typeof own === 'number' ? own : (view.council?.threshold ?? 0)
}

const waiting = (p: GovernanceProposalView, now: Date) =>
  !!p.executableAfter && Date.parse(p.executableAfter) > now.getTime()

export function proposalState(
  p: GovernanceProposalView,
  view: GovernanceView,
  now: Date,
): ItemState {
  const threshold = thresholdOf(p, view)
  const expired = expiredAt(p.expiresAt, now)
  const enough = p.approvals.length >= threshold
  if (expired) return { label: 'Expired', tone: 'blocked', expired, threshold }
  if (enough && p.trusted)
    return { label: 'Approved, the operator executes it', tone: 'done', expired, threshold }
  // Risk 9: a lower liquidation factor waits 2 days after the proposal
  if (enough && waiting(p, now))
    return { label: 'Approved, waits for the 2-day delay', tone: 'wait', expired, threshold }
  if (enough) return { label: 'Ready to execute', tone: 'ready', expired, threshold }
  return {
    label: `${p.approvals.length} of ${threshold} approvals`,
    tone: 'wait',
    expired,
    threshold,
  }
}

export function proposalActions(
  p: GovernanceProposalView,
  view: GovernanceView,
  me: string | null,
  now: Date,
): Action[] {
  if (!me) return []
  const s = proposalState(p, view, now)
  const member = !!view.council?.members.includes(me)
  const out: Action[] = []
  if (!s.expired && member && !p.approvals.includes(me))
    out.push({ action: 'approve', label: 'Approve' })
  // Role and factory changes are executed by the operator (Proposal_ExecuteTrusted), not via HTTP
  if (!s.expired && member && !p.trusted && p.approvals.length >= s.threshold && !waiting(p, now))
    out.push({ action: 'execute', label: 'Execute' })
  if (p.proposer === me) out.push({ action: 'withdraw', label: 'Withdraw' })
  return out
}

/** New members who have not signed the rotation yet. */
export const missingJoins = (r: CouncilRotationView) =>
  r.newMembers.filter((m) => !r.members.includes(m) && !r.joined.includes(m))

/** Rotation threshold is the current council's threshold; 0 when forming the first council. */
const rotationThreshold = (r: CouncilRotationView, view: GovernanceView) =>
  r.formation ? 0 : thresholdOf(r, view)

export function rotationState(r: CouncilRotationView, view: GovernanceView, now: Date): ItemState {
  const threshold = rotationThreshold(r, view)
  const expired = expiredAt(r.expiresAt, now)
  const missing = missingJoins(r).length
  if (expired) return { label: 'Expired', tone: 'blocked', expired, threshold }
  if (r.approvals.length < threshold)
    return {
      label: `${r.approvals.length} of ${threshold} approvals`,
      tone: 'wait',
      expired,
      threshold,
    }
  if (missing > 0)
    return {
      label: `Waiting for ${missing} new member${missing === 1 ? '' : 's'} to join`,
      tone: 'wait',
      expired,
      threshold,
    }
  if (r.formation)
    return { label: 'Everyone joined, the operator executes it', tone: 'done', expired, threshold }
  return { label: 'Ready to execute', tone: 'ready', expired, threshold }
}

export function rotationActions(
  r: CouncilRotationView,
  view: GovernanceView,
  me: string | null,
  now: Date,
): Action[] {
  if (!me) return []
  const s = rotationState(r, view, now)
  const out: Action[] = []
  const oldMember = r.members.includes(me)
  if (!s.expired && oldMember && !r.approvals.includes(me))
    out.push({ action: 'approve', label: 'Approve' })
  if (!s.expired && r.newMembers.includes(me) && !oldMember && !r.joined.includes(me))
    out.push({ action: 'join', label: 'Join the council' })
  if (s.tone === 'ready' && oldMember) out.push({ action: 'execute', label: 'Execute' })
  if (r.proposer === me) out.push({ action: 'withdraw', label: 'Withdraw' })
  return out
}

export function incomeState(i: IncomeProposalView, view: GovernanceView, now: Date): ItemState {
  const threshold = thresholdOf(i, view)
  const expired = expiredAt(i.expiresAt, now)
  if (expired) return { label: 'Expired', tone: 'blocked', expired, threshold }
  if (i.approvals.length < threshold)
    return {
      label: `${i.approvals.length} of ${threshold} approvals`,
      tone: 'wait',
      expired,
      threshold,
    }
  return { label: 'Approved, the treasury receives it', tone: 'ready', expired, threshold }
}

export function incomeActions(
  i: IncomeProposalView,
  view: GovernanceView,
  me: string | null,
  now: Date,
): Action[] {
  if (!me) return []
  const s = incomeState(i, view, now)
  const member = !!view.council?.members.includes(me)
  const out: Action[] = []
  if (!s.expired && member && !i.approvals.includes(me))
    out.push({ action: 'approve', label: 'Approve' })
  if (s.tone === 'ready' && i.treasury === me && view.roles.treasury === me)
    out.push({ action: 'execute', label: 'Receive income' })
  if (i.proposer === me) out.push({ action: 'withdraw', label: 'Withdraw' })
  return out
}

/** Intent of an action on an open proposal: checked by the verifier (F-1). */
export function actionIntent(
  kind: GovernanceKind,
  action: GovernanceAction,
  contractId: string,
  treasury: string,
): Intent {
  switch (`${kind}/${action}`) {
    case 'proposals/approve':
      return { kind: 'proposal-approve', proposalCid: contractId }
    case 'proposals/execute':
      return { kind: 'proposal-execute', proposalCid: contractId }
    case 'proposals/withdraw':
      return { kind: 'proposal-withdraw', proposalCid: contractId }
    case 'rotations/approve':
      return { kind: 'rotation-approve', rotationCid: contractId }
    case 'rotations/join':
      return { kind: 'rotation-join', rotationCid: contractId }
    case 'rotations/execute':
      return { kind: 'rotation-execute', rotationCid: contractId }
    case 'rotations/withdraw':
      return { kind: 'rotation-withdraw', rotationCid: contractId }
    case 'income/approve':
      return { kind: 'income-approve', incomeCid: contractId }
    case 'income/execute':
      return { kind: 'income-execute', incomeCid: contractId, treasury }
    case 'income/withdraw':
      return { kind: 'income-withdraw', incomeCid: contractId }
    default:
      throw new Error(`unknown governance action ${kind}/${action}`)
  }
}

export interface ParamChange {
  scope: Scope
  field: string
  value: string
}

/** Form changes → paramsPatch and marketParamsPatch; a repeated field is an error. */
export function patchesOf(changes: ParamChange[]): {
  paramsPatch: Record<string, string>
  marketParamsPatch: Partial<Record<MarketId, Record<string, string>>>
} {
  const paramsPatch: Record<string, string> = {}
  const marketParamsPatch: Partial<Record<MarketId, Record<string, string>>> = {}
  for (const c of changes) {
    const target =
      c.scope === 'protocol'
        ? paramsPatch
        : (marketParamsPatch[c.scope] ??= {} as Record<string, string>)
    if (Object.hasOwn(target, c.field))
      throw new Error(`${c.scope === 'protocol' ? '' : `${c.scope} `}${c.field} is changed twice`)
    target[c.field] = c.value
  }
  return { paramsPatch, marketParamsPatch }
}

/** Party list from an input field: one per line or comma-separated, no empties. */
export const partiesOf = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)

export const sameRoles = (a: GovernanceRolesView, b: GovernanceRolesView) =>
  a.operator === b.operator &&
  a.oracle === b.oracle &&
  a.guardian === b.guardian &&
  a.treasury === b.treasury &&
  a.backstop === b.backstop &&
  a.liquidators.length === b.liquidators.length &&
  a.liquidators.every((l, i) => l === b.liquidators[i])

/** Default id: kind and minute, e.g. params-20261001-1405. */
export function defaultId(prefix: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${prefix}-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
}

export const EXPIRY_OPTIONS = [
  ['1', '1 day'],
  ['3', '3 days'],
  ['7', '7 days'],
] as const

export const expiresIn = (days: string, now = Date.now()) =>
  new Date(now + Number(days) * 24 * 3600_000).toISOString()

// What the proposal changes --------------------------------------------------------------

/** "now → will be" comparison row for the proposal card. */
export interface ChangeRow {
  key: string
  label: string
  from: string | null
  to: string | null
  /** Values are parties (roles, factories, Featured App right): show them short */
  parties: boolean
}

const ROLE_FIELD_LABELS: Record<string, string> = {
  operator: 'Operator',
  oracle: 'Oracle',
  guardian: 'Guardian',
  treasury: 'Treasury',
  backstop: 'Backstop',
  liquidators: 'Liquidators',
}

/**
 * A value that is a valid decimal but almost surely a slip (review follow-up): liquidationFactor is
 * the credited share, so 0.07 meant as a 7% penalty would set a 93% penalty. null: no warning.
 */
export function suspiciousValue(field: string, value: string): string | null {
  if (field === 'liquidationFactor' && /^0(\.[0-4]\d*)?$/.test(value))
    return 'This field is the share credited on absorb, not the penalty: 0.93 means a 7% penalty, and a value below 0.5 means a penalty above 50%'
  return null
}

/**
 * Fields whose decrease waits 2 days after the proposal (Governance.daml, liquidationFactorDelay):
 * a lower Liquidation Factor or a bigger penalty would absorb accounts at once (review item 33).
 */
const DELAYED_FIELDS = new Set(['liquidateCollateralFactor', 'liquidationFactor'])

export function delayNote(field: string): string | null {
  return DELAYED_FIELDS.has(field)
    ? 'Lowering it executes no sooner than 2 days after the proposal, so pick an expiry over 2 days. Raising it executes at once. For a quick demo, change the Collateral Factor or the Minimum loan.'
    : null
}

/** The label of a protocol or market parameter, the same in the form, the summary and the diff. */
export const paramLabel = (scope: 'protocol' | 'market', field: string) =>
  labelOf(scope === 'protocol' ? PROTOCOL_FIELDS : MARKET_FIELDS, field)

const labelOf = (fields: readonly (readonly [string, string])[], field: string) =>
  fields.find(([k]) => k === field)?.[1] ??
  field.replace(/^rateModel\./, 'Rate model: ').replace(/\./g, ' ')

/** Decimal string without trailing zeros: "0.0200000000" → "0.02". No Number: amounts are strings. */
export function trimDecimal(v: string | null): string | null {
  if (v === null || !/^-?\d+\.\d+$/.test(v)) return v
  return v.replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Changes from GET /governance in words. Display only: what gets signed is decided by
 * the command the verifier checks (the proposal contract by its id).
 */
export function changeRows(changes: readonly GovernanceChange[]): ChangeRow[] {
  return changes.map((c): ChangeRow => {
    const key = `${c.scope}/${c.target ?? ''}/${c.field}`
    const row = (label: string, parties = false): ChangeRow => ({
      key,
      label,
      from: parties ? c.from : trimDecimal(c.from),
      to: parties ? c.to : trimDecimal(c.to),
      parties,
    })
    switch (c.scope) {
      case 'protocol':
        return row(labelOf(PROTOCOL_FIELDS, c.field))
      case 'market':
        return c.field
          ? row(`${c.target}: ${labelOf(MARKET_FIELDS, c.field)}`)
          : row(c.to === null ? `${c.target}: market removed` : `${c.target}: new market`)
      case 'roles':
        return row(ROLE_FIELD_LABELS[c.field] ?? c.field, true)
      case 'factories': {
        const id = (c.target ?? '').split('::').at(-1) ?? c.target ?? ''
        return row(c.field ? `Transfer factory ${id}: ${c.field}` : `Transfer factory ${id}`, true)
      }
      case 'featuredAppRight':
        return row('Featured App right', true)
    }
  })
}
