/**
 * Checking a prepared command before signing (audit F-1).
 *
 * The backend builds the command, the user's wallet signs it. A tampered API response
 * (compromised backend, proxy, MITM) could slip in, for example, a transfer of all
 * holdings to another party. So the frontend checks the command against the user's intent
 * against an allowlist and refuses to sign anything else:
 * - actAs is exactly the connected party;
 * - exactly one command, with a template and choice from the list for this operation;
 * - user/actor is the connected party, operator is the expected operator;
 * - amount and market are what the user entered ("all" follows rule F-11);
 * - transfer inputs are a subset of the holdings chosen by the frontend itself;
 * - the pool, config and factory contracts are among the disclosed contracts.
 *
 * Template identifiers are pinned in the bundle, not taken from the API.
 * Module without React and without alias imports: vitest runs it.
 */
import {
  type MarketId,
  PAUSE_FLAG_CONSTRUCTORS,
  type PauseFlagName,
  type PauseView,
  type PreparedCommand,
} from '@lending/shared'
import { paramLabel } from '../features/council/model.ts'
import { add, cmp, isDecimal, mulRatio } from '../lib/decimal.ts'
import { formatTime } from '@/lib/dates'

/**
 * Compound V3 model: new packages lending-core-v2 and lending-governance-v2 (their fields are not an
 * upgrade of lending-core), referenced by package name.
 */
export const TEMPLATES = {
  config: '#lending-core-v2:Lending.Config:ProtocolConfig',
  pool: '#lending-core-v2:Lending.Pool:Pool',
  account: '#lending-core-v2:Lending.Account:Account',
  accountRequest: '#lending-core-v2:Lending.Account:AccountRequest',
  login: '#lending-core-v2:Lending.Auth:Login',
  // K7: pause flags in their own contract, the guardian is the controller
  pauseState: '#lending-core-v2:Lending.Pause:PauseState',
  council: '#lending-governance-v2:Lending.Governance:GovernanceCouncil',
  proposal: '#lending-governance-v2:Lending.Governance:ParameterChangeProposal',
  rotation: '#lending-governance-v2:Lending.Governance:CouncilRotation',
  income: '#lending-governance-v2:Lending.Governance:IncomeProposal',
} as const

/** Package names of the protocol contracts, as the node reports them in events. */
export const CORE_PACKAGE = 'lending-core-v2'

/** Token Standard incoming transfer interface: the DevNet faucet sends tokens as an offer. */
export const TRANSFER_INSTRUCTION =
  '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction'

/** Incoming transfer read from the user's node (with their token, not from the protocol API). */
export interface OfferSeen {
  sender: string
  receiver: string
  instrumentId: { admin: string; id: string }
  amount: string
}

/** Protocol roles in a council proposal (Lending.Types.Roles). */
export interface RolesIntent {
  operator: string
  oracle: string
  guardian: string
  treasury: string
  backstop: string
  liquidators: string[]
}

/** Login lives at most 15 minutes (seam 2 in fix-contracts); one minute is for clock skew. */
export const MAX_LOGIN_TTL_MS = 15 * 60_000
const CLOCK_SKEW_MS = 60_000

/**
 * "All" (F-11, K2): the command carries `full = True`. Repay all (Pool_SupplyBase): `amount` is the
 * cap the user pays; the contract charges exactly the debt rounded up. The backend sets the cap to the
 * debt at signature expiry; the frontend allows at most the snapshot debt + 0.2 %. Withdraw all
 * (Pool_WithdrawBase): the contract pays the whole deposit and never borrows; `amount` only has to be
 * positive.
 */
const REPAY_ALL_MARGIN = { num: 1002n, den: 1000n }
const TOKEN_STEP = '0.0000000001'

type Amount = string
type AmountOrAll = string | 'max'

/** What the user wants to do: exactly this must end up in the command. */
export type Intent =
  | { kind: 'login'; nonce: string }
  | { kind: 'open-account' }
  | { kind: 'supply'; amount: Amount; inputs?: string[] }
  /** Supply that pays the debt (K2); "max": repay exactly the debt (full) */
  | { kind: 'repay'; amount: AmountOrAll; debt?: string; inputs?: string[] }
  /** Never borrows: allowBorrow = False; "max": the whole deposit (full) */
  | { kind: 'withdraw'; amount: AmountOrAll; balance?: string }
  /** Withdrawal that may go below zero: allowBorrow = True, never "all" */
  | { kind: 'borrow'; amount: Amount }
  | { kind: 'deposit-collateral'; marketId: MarketId; amount: Amount; inputs?: string[] }
  | { kind: 'withdraw-collateral'; marketId: MarketId; amount: Amount; collateral?: string }
  /** Guardian: one flag set as chosen (PauseState_SetFlag, 1.0.2): the others are not touched */
  | { kind: 'pause'; flag: PauseFlagName; paused: boolean }
  /** Treasury: USDCx into the pool cash (Pool_AddReserves) */
  | { kind: 'add-reserves'; amount: Amount; inputs?: string[] }
  /** Approved buyer: absorbed collateral for USDCx, not less than the minimum (Pool_BuyCollateral) */
  | {
      kind: 'buy-collateral'
      marketId: MarketId
      amount: Amount
      minCollateral: Amount
      inputs?: string[]
    }
  // 0.4.0: the council signs with its own wallet (D-5, N4)
  | {
      kind: 'council-propose'
      councilCid: string
      proposalId: string
      description: string
      /** ISO expiry time chosen by the council member */
      expiresAt: string
      /** Changed decimal fields of ProtocolParams: exactly these must differ */
      paramsPatch: Record<string, Amount>
      /** Changed MarketParams fields per market; the set of markets does not change */
      marketParamsPatch: Partial<Record<MarketId, Record<string, Amount>>>
      /** Expected new roles; null means the proposal does not change roles */
      newRoles: RolesIntent | null
    }
  | { kind: 'proposal-approve'; proposalCid: string }
  | { kind: 'proposal-execute'; proposalCid: string }
  | { kind: 'proposal-withdraw'; proposalCid: string }
  | {
      kind: 'rotation-propose'
      councilCid: string
      rotationId: string
      newMembers: string[]
      newThreshold: number
      /** the expiry the member chose: a server cannot stretch the window to sign later */
      expiresAt: string
    }
  | { kind: 'rotation-approve'; rotationCid: string }
  | { kind: 'rotation-join'; rotationCid: string }
  | { kind: 'rotation-execute'; rotationCid: string }
  | { kind: 'rotation-withdraw'; rotationCid: string }
  | {
      kind: 'income-propose'
      councilCid: string
      proposalId: string
      /** Treasury from ProtocolConfig: revenue goes only there */
      treasury: string
      reservesAmount: Amount
    }
  | { kind: 'income-approve'; incomeCid: string }
  | { kind: 'income-execute'; incomeCid: string; treasury: string }
  | { kind: 'income-withdraw'; incomeCid: string }
  /**
   * Accept an incoming faucet transfer (DevNet). offer is the transfer itself, read by the wallet
   * from the user's node; without it only the command shape is checked.
   */
  | {
      kind: 'accept-transfer'
      offerCid: string
      instrument: { admin: string; id: string }
      amount: Amount
      symbol: string
      offer?: OfferSeen | null
    }

export interface VerifyContext {
  /** The wallet's connected party */
  party: string
  /** Expected protocol operator (pinned in the build or from /config) */
  operator: string
  /**
   * The user's account, if known. For the node wallet it is read from the user's node
   * and checked against the operator: Daml `fetchAccount operator user` then prevents substituting
   * another pool with a different operator.
   */
  accountCid?: string | null
  /**
   * Current ProtocolConfig from the council member's node: the unchanged fields
   * of the proposal are checked against it. Without it only the changes are checked.
   */
  config?: { contractId: string; params: unknown; marketParams: unknown } | null
  now: Date
}

/** What will be signed: a title and human-readable lines. */
export interface SignSummary {
  title: string
  lines: string[]
  /** Exact text the wallet will sign (Loop: signMessage); show it as is */
  message?: string
  /** An automatic retry: why the wallet asks again (review item 32) */
  retry?: string
}

export class CommandRejected extends Error {
  constructor(reason: string) {
    super(`Refused to sign: ${reason}. Nothing was sent to your wallet.`)
    this.name = 'CommandRejected'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function need(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new CommandRejected(reason)
}

const short = (p: string) => {
  const [hint = p, ns = ''] = p.split('::')
  return ns ? `${hint}::${ns.slice(0, 8)}…` : hint
}

const cidShort = (cid: string) => (cid.length > 16 ? `${cid.slice(0, 12)}…` : cid)

/** Choice fields: known ones are required by the checks below, unknown ones only empty (new Optionals). */
function onlyKnown(args: Obj, known: readonly string[]) {
  for (const [k, v] of Object.entries(args))
    need(known.includes(k) || v === null, `unexpected field "${k}" in the command`)
}

function sameAmount(got: unknown, want: string, what = 'amount') {
  need(isDecimal(got), `${what} in the command is not a decimal`)
  need(cmp(got, want) === 0, `${what} ${got} differs from the ${want} you entered`)
}

interface Parsed {
  kind: 'create' | 'exercise'
  templateId: string
  contractId?: string
  choice?: string
  args: Obj
}

function single(p: PreparedCommand, ctx: VerifyContext): Parsed {
  need(isObj(p), 'the server response is not a command')
  need(
    Array.isArray(p.actAs) && p.actAs.length === 1 && p.actAs[0] === ctx.party,
    'the command acts for another party',
  )
  need(Array.isArray(p.commands) && p.commands.length === 1, 'expected exactly one command')
  need(Array.isArray(p.disclosedContracts), 'disclosed contracts are missing')
  for (const d of p.disclosedContracts)
    need(
      isObj(d) && typeof d.createdEventBlob === 'string' && typeof d.contractId === 'string',
      'malformed disclosed contract',
    )
  const c = p.commands[0]
  need(isObj(c), 'malformed command')
  const keys = Object.keys(c)
  need(keys.length === 1, 'malformed command')
  if (isObj(c.CreateCommand)) {
    const x = c.CreateCommand
    need(typeof x.templateId === 'string' && isObj(x.createArguments), 'malformed create command')
    return { kind: 'create', templateId: x.templateId, args: x.createArguments }
  }
  if (isObj(c.ExerciseCommand)) {
    const x = c.ExerciseCommand
    need(
      typeof x.templateId === 'string' &&
        typeof x.contractId === 'string' &&
        typeof x.choice === 'string' &&
        isObj(x.choiceArgument),
      'malformed exercise command',
    )
    return {
      kind: 'exercise',
      templateId: x.templateId,
      contractId: x.contractId,
      choice: x.choice,
      args: x.choiceArgument,
    }
  }
  throw new CommandRejected(`command type ${keys[0]} is not allowed`)
}

const disclosedIds = (p: PreparedCommand) =>
  new Set((p.disclosedContracts as Obj[]).map((d) => d.contractId as string))

function disclosedAs(p: PreparedCommand, cid: unknown, suffix: RegExp, what: string) {
  need(typeof cid === 'string', `${what} id is missing`)
  const d = (p.disclosedContracts as Obj[]).find((x) => x.contractId === cid)
  need(d, `${what} is not among the disclosed contracts`)
  need(
    typeof d.templateId === 'string' && suffix.test(d.templateId),
    `${what} has a wrong template`,
  )
}

/** Choice on the protocol pool: template pinned, pool and config disclosed by the server. */
function poolChoice(p: PreparedCommand, cmd: Parsed, choice: string, known: readonly string[]) {
  need(cmd.kind === 'exercise', `expected ${choice}`)
  need(cmd.templateId === TEMPLATES.pool, 'the command targets an unknown template')
  need(cmd.choice === choice, `expected ${choice}, got ${cmd.choice}`)
  disclosedAs(p, cmd.contractId, /:Lending\.Pool:Pool$/, 'the pool')
  disclosedAs(p, cmd.args.configCid, /:Lending\.Config:ProtocolConfig$/, 'the protocol config')
  onlyKnown(cmd.args, ['configCid', ...known])
  return cmd.args
}

function userAndAccount(args: Obj, ctx: VerifyContext) {
  need(args.user === ctx.party, 'the command is for another user')
  need(typeof args.accountCid === 'string', 'account id is missing')
  if (ctx.accountCid) need(args.accountCid === ctx.accountCid, 'the command uses another account')
}

/** Transfer from the user: only their holdings chosen by the frontend, and a disclosed factory. */
function transferArgs(p: PreparedCommand, v: unknown, inputs: string[] | undefined, what: string) {
  need(isObj(v), `${what} is missing`)
  need(
    typeof v.factoryCid === 'string' && disclosedIds(p).has(v.factoryCid),
    `${what}: transfer factory is not disclosed`,
  )
  need(
    Array.isArray(v.inputHoldingCids) &&
      v.inputHoldingCids.length > 0 &&
      v.inputHoldingCids.every((x) => typeof x === 'string'),
    `${what}: no input holdings`,
  )
  if (inputs) {
    const allowed = new Set(inputs)
    need(
      (v.inputHoldingCids as string[]).every((x) => allowed.has(x)),
      `${what} spends holdings the app did not select`,
    )
  }
}

/** Choice on the council contract: template pinned, the contract is the one the user chose. */
function govChoice(
  cmd: Parsed,
  templateId: string,
  contractId: string,
  choice: string,
  known: readonly string[],
) {
  need(cmd.kind === 'exercise', `expected ${choice}`)
  need(cmd.templateId === templateId, 'the command targets an unknown template')
  need(cmd.choice === choice, `expected ${choice}, got ${String(cmd.choice)}`)
  need(cmd.contractId === contractId, 'the command targets another contract')
  onlyKnown(cmd.args, known)
  return cmd.args
}

const sameList = (a: unknown, b: string[]) =>
  Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])

function sameRoles(got: unknown, want: RolesIntent): boolean {
  if (!isObj(got)) return false
  onlyKnown(got, ['operator', 'oracle', 'guardian', 'treasury', 'backstop', 'liquidators'])
  return (
    got.operator === want.operator &&
    got.oracle === want.oracle &&
    got.guardian === want.guardian &&
    got.treasury === want.treasury &&
    got.backstop === want.backstop &&
    sameList(got.liquidators, want.liquidators)
  )
}

/** Daml tuple in the JSON Ledger API: {_1, _2}. */
const tuple = (v: unknown): [unknown, unknown] | null =>
  isObj(v) && Object.keys(v).length === 2 && '_1' in v && '_2' in v ? [v._1, v._2] : null

const market = (args: Obj, want: MarketId) =>
  need(args.marketId === want, `the command is for market ${String(args.marketId)}, not ${want}`)

/** The "all" flag (K2): Bool `full`; a typed amount must carry False. */
function noFullFlag(args: Obj) {
  need(args.full === false, 'the command takes everything, not the amount you entered')
}

/** Pause flags (Lending.Types.PauseFlags) with their names on screen. */
export const PAUSE_FLAGS = [
  'borrowPaused',
  'collateralWithdrawPaused',
  'supplyWithdrawPaused',
  'absorbPaused',
  'buyPaused',
] as const satisfies readonly (keyof PauseView)[]

export const PAUSE_LABELS: Record<(typeof PAUSE_FLAGS)[number], string> = {
  borrowPaused: 'New loans',
  collateralWithdrawPaused: 'Collateral withdrawals',
  supplyWithdrawPaused: 'USDCx withdrawals',
  absorbPaused: 'Absorbing positions',
  buyPaused: 'Collateral sales',
}

/** PriceArgs (K3): feeds and attestations, all disclosed with their pinned templates. */
function priceArgs(p: PreparedCommand, v: unknown) {
  need(isObj(v), 'the price arguments are missing')
  onlyKnown(v, ['collateralFeedCids', 'debtFeedCid', 'attestationCids'])
  need(Array.isArray(v.collateralFeedCids), 'collateral price feeds are missing')
  for (const c of v.collateralFeedCids as unknown[])
    disclosedAs(p, c, /:Lending\.Oracle:PriceFeed$/, 'a collateral price feed')
  if (v.debtFeedCid !== null && v.debtFeedCid !== undefined)
    disclosedAs(p, v.debtFeedCid, /:Lending\.Oracle:PriceFeed$/, 'the USDCx price feed')
  need(Array.isArray(v.attestationCids), 'reserve attestations are missing')
  for (const c of v.attestationCids as unknown[])
    disclosedAs(p, c, /:Lending\.Oracle:ReserveAttestation$/, 'a reserve attestation')
}

/** Equality of Daml values in JSON: decimal strings are compared as numbers. */
function sameValue(a: unknown, b: unknown): boolean {
  if (isDecimal(a) && isDecimal(b)) return cmp(a, b) === 0
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameValue(x, b[i]))
    )
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    // a missing field and null are the same empty Optional
    return [...keys].every((k) => sameValue(a[k] ?? null, b[k] ?? null))
  }
  return a === b
}

/** Map MarketId MarketParams in the JSON Ledger API: [[key, value], …] (or {_1, _2}). */
function marketMap(v: unknown, what: string): Map<string, Obj> {
  need(Array.isArray(v), `${what} is not a market map`)
  const out = new Map<string, Obj>()
  for (const e of v) {
    const pair = Array.isArray(e) && e.length === 2 ? [e[0], e[1]] : tuple(e)
    need(pair && typeof pair[0] === 'string' && isObj(pair[1]), `${what} is malformed`)
    need(!out.has(pair[0]), `${what} repeats market ${pair[0]}`)
    out.set(pair[0], pair[1])
  }
  return out
}

/**
 * Proposal parameters: changed fields are exactly the entered ones, the rest are as in the current
 * config (if it was read from the wallet ledger). Returns lines for the summary.
 */
function checkParams(
  a: Obj,
  intent: Extract<Intent, { kind: 'council-propose' }>,
  ctx: VerifyContext,
): string[] {
  const lines: string[] = []
  need(isObj(a.newParams), 'the proposal has no protocol parameters')
  // `rateModel.slope1`: a field of a nested record (review 03.10, item 16)
  const at = (o: Obj, path: string): unknown =>
    path.split('.').reduce<unknown>((x, p) => (isObj(x) ? x[p] : undefined), o)
  for (const [k, v] of Object.entries(intent.paramsPatch)) {
    const label = paramLabel('protocol', k)
    need(isDecimal(v), `${label}: enter a decimal`)
    const got = at(a.newParams, k)
    need(
      isDecimal(got) && cmp(got, v) === 0,
      `${label} in the proposal differs from the ${v} you entered`,
    )
    lines.push(`${label} → ${v}`)
  }
  const markets = marketMap(a.newMarketParams, 'market parameters')
  for (const [id, patch] of Object.entries(intent.marketParamsPatch)) {
    const mp = markets.get(id)
    need(mp, `market ${id} is missing from the proposal`)
    for (const [k, v] of Object.entries(patch ?? {})) {
      const label = paramLabel('market', k)
      need(isDecimal(v), `${id} ${label}: enter a decimal`)
      need(
        isDecimal(mp[k]) && cmp(mp[k], v) === 0,
        `${id} ${label} in the proposal differs from the ${v} you entered`,
      )
      lines.push(`${id} ${label} → ${v}`)
    }
  }
  if (!ctx.config) {
    lines.push('Other parameters are not checked: your wallet does not show the protocol config')
    return lines
  }
  need(a.configCid === ctx.config.contractId, 'the proposal starts from another protocol config')
  need(isObj(ctx.config.params), 'the protocol config in your wallet is malformed')
  for (const k of new Set([...Object.keys(a.newParams), ...Object.keys(ctx.config.params)])) {
    if (Object.hasOwn(intent.paramsPatch, k)) continue
    const was = ctx.config.params[k]
    const now = a.newParams[k]
    // a nested record (rateModel): only its patched fields may differ
    if (isObj(was) && isObj(now)) {
      for (const f of new Set([...Object.keys(now), ...Object.keys(was)])) {
        if (Object.hasOwn(intent.paramsPatch, `${k}.${f}`)) continue
        need(
          sameValue(now[f] ?? null, was[f] ?? null),
          `the proposal also changes ${paramLabel('protocol', `${k}.${f}`)}`,
        )
      }
      continue
    }
    need(
      sameValue(now ?? null, was ?? null),
      `the proposal also changes ${paramLabel('protocol', k)}`,
    )
  }
  const base = marketMap(ctx.config.marketParams, 'the config market parameters')
  need(
    base.size === markets.size && [...base.keys()].every((id) => markets.has(id)),
    'the proposal changes the set of markets',
  )
  for (const [id, mp] of markets) {
    const was = base.get(id)!
    const patch = intent.marketParamsPatch[id as MarketId] ?? {}
    for (const k of new Set([...Object.keys(mp), ...Object.keys(was)])) {
      if (Object.hasOwn(patch, k)) continue
      need(
        sameValue(mp[k] ?? null, was[k] ?? null),
        `the proposal also changes ${id} ${paramLabel('market', k)}`,
      )
    }
  }
  lines.push('Everything else matches the protocol config in your wallet')
  return lines
}

/**
 * Check the command against the intent. Returns the description for the "You are signing" dialog,
 * otherwise throws CommandRejected. Does not change the command.
 */
export function verifyPrepared(
  p: PreparedCommand,
  intent: Intent,
  ctx: VerifyContext,
): SignSummary {
  const cmd = single(p, ctx)
  const operator = short(ctx.operator)
  switch (intent.kind) {
    case 'login': {
      need(cmd.kind === 'create' && cmd.templateId === TEMPLATES.login, 'expected a Login contract')
      need(p.disclosedContracts.length === 0, 'login must not use disclosed contracts')
      const a = cmd.args
      onlyKnown(a, ['user', 'operator', 'nonce', 'expiresAt'])
      need(a.user === ctx.party, 'the login is for another party')
      need(a.operator === ctx.operator, 'the login names an unknown operator')
      need(a.nonce === intent.nonce, 'the login nonce does not match the challenge')
      need(typeof a.expiresAt === 'string', 'the login has no expiry')
      const exp = Date.parse(a.expiresAt)
      const now = ctx.now.getTime()
      need(Number.isFinite(exp) && exp > now, 'the login is already expired')
      need(exp <= now + MAX_LOGIN_TTL_MS + CLOCK_SKEW_MS, 'the login lives too long')
      return {
        title: 'Sign in to Canton Lending',
        lines: [
          `Create a Login contract for ${short(ctx.party)}`,
          `Seen by the protocol operator ${operator}, moves no funds`,
          `Expires at ${formatTime(exp)}`,
        ],
      }
    }
    case 'open-account': {
      need(
        cmd.kind === 'create' && cmd.templateId === TEMPLATES.accountRequest,
        'expected an account request',
      )
      need(p.disclosedContracts.length === 0, 'account request must not use disclosed contracts')
      onlyKnown(cmd.args, ['operator', 'user'])
      need(cmd.args.user === ctx.party, 'the request is for another party')
      need(cmd.args.operator === ctx.operator, 'the request names an unknown operator')
      return {
        title: 'Open a lending account',
        lines: [`Request an account from the operator ${operator}`, 'Moves no funds'],
      }
    }
    case 'supply':
    case 'repay': {
      const a = poolChoice(p, cmd, 'Pool_SupplyBase', [
        'user',
        'accountCid',
        'amount',
        'full',
        'payment',
      ])
      userAndAccount(a, ctx)
      transferArgs(p, a.payment, intent.inputs, 'payment')
      need(isDecimal(a.amount), 'amount in the command is not a decimal')
      const from = `From ${(a.payment as Obj & { inputHoldingCids: string[] }).inputHoldingCids.length} of your USDCx holdings`
      if (intent.amount !== 'max') {
        noFullFlag(a)
        sameAmount(a.amount, intent.amount)
        return {
          title: `${intent.kind === 'repay' ? 'Repay' : 'Supply'} ${intent.amount} USDCx`,
          lines: [
            `Pool_SupplyBase: pay ${intent.amount} USDCx to the protocol operator ${operator}`,
            'Your debt is repaid first, the rest is supplied and earns interest',
            from,
          ],
        }
      }
      // "Repay all" (F-11, K2): full flag, cap at most the snapshot debt + 0.2 %; the contract
      // charges exactly the debt rounded up
      need(intent.kind === 'repay', 'only a repayment can take the whole debt')
      need(a.full === true, 'the command is not marked "repay all"')
      need(intent.debt !== undefined, 'your current debt is unknown')
      const limit = add(
        mulRatio(intent.debt, REPAY_ALL_MARGIN.num, REPAY_ALL_MARGIN.den),
        TOKEN_STEP,
      )
      need(cmp(a.amount, intent.debt) >= 0, 'the command repays less than your debt')
      need(
        cmp(a.amount, limit) <= 0,
        `the command allows ${a.amount} USDCx, more than your debt ${intent.debt} plus 0.2%`,
      )
      return {
        title: `Repay the whole debt, up to ${a.amount} USDCx`,
        lines: [
          `Pool_SupplyBase, "repay all": your debt is ${intent.debt} USDCx now`,
          `Your wallet shows up to ${a.amount} USDCx; the contract charges exactly the debt at execution and returns the change`,
        ],
      }
    }
    case 'withdraw':
    case 'borrow': {
      const a = poolChoice(p, cmd, 'Pool_WithdrawBase', [
        'user',
        'pauseCid',
        'accountCid',
        'amount',
        'full',
        'allowBorrow',
        'prices',
        'payout',
      ])
      userAndAccount(a, ctx)
      disclosedAs(p, a.pauseCid, /:Lending\.Pause:PauseState$/, 'the pause flags')
      priceArgs(p, a.prices)
      transferArgs(p, a.payout, undefined, 'payout')
      need(isDecimal(a.amount), 'amount in the command is not a decimal')
      if (intent.kind === 'borrow') {
        // Risk 7: a loan is only what the user asked for as a loan
        need(a.allowBorrow === true, 'the command does not allow the loan you asked for')
        noFullFlag(a)
        sameAmount(a.amount, intent.amount)
        return {
          title: `Borrow ${intent.amount} USDCx`,
          lines: [
            `Pool_WithdrawBase with borrowing allowed: receive ${intent.amount} USDCx from ${operator}`,
            'Your USDCx supply is used first, the rest becomes debt against all your collateral',
            'Your wallet pays nothing now',
          ],
        }
      }
      // A withdrawal never turns into a loan (risk 7): allowBorrow must be False
      need(a.allowBorrow === false, 'the withdrawal would be allowed to borrow')
      if (intent.amount !== 'max') {
        noFullFlag(a)
        sameAmount(a.amount, intent.amount)
        return {
          title: `Withdraw ${intent.amount} USDCx`,
          lines: [
            `Pool_WithdrawBase: receive ${intent.amount} USDCx from ${operator}`,
            'Never borrows: the contract rejects it if your balance would go below zero',
          ],
        }
      }
      need(a.full === true, 'the command is not marked "withdraw all"')
      need(cmp(a.amount, '0') > 0, 'the command amount must be positive')
      return {
        title: 'Withdraw your whole supply',
        lines: [
          `Pool_WithdrawBase, "withdraw all": receive your whole USDCx supply from ${operator}${intent.balance ? `, ${intent.balance} USDCx now` : ''}`,
          'The contract pays your balance at execution, interest included, and never borrows',
        ],
      }
    }
    case 'deposit-collateral': {
      const a = poolChoice(p, cmd, 'Pool_SupplyCollateral', [
        'user',
        'accountCid',
        'marketId',
        'amount',
        'payment',
      ])
      userAndAccount(a, ctx)
      market(a, intent.marketId)
      sameAmount(a.amount, intent.amount)
      transferArgs(p, a.payment, intent.inputs, 'payment')
      return {
        title: `Supply ${intent.amount} ${intent.marketId} as collateral`,
        lines: [
          `Pool_SupplyCollateral: pay ${intent.amount} ${intent.marketId} to the protocol operator ${operator}`,
        ],
      }
    }
    case 'withdraw-collateral': {
      const a = poolChoice(p, cmd, 'Pool_WithdrawCollateral', [
        'user',
        'pauseCid',
        'accountCid',
        'marketId',
        'amount',
        'prices',
        'payout',
      ])
      userAndAccount(a, ctx)
      market(a, intent.marketId)
      disclosedAs(p, a.pauseCid, /:Lending\.Pause:PauseState$/, 'the pause flags')
      priceArgs(p, a.prices)
      transferArgs(p, a.payout, undefined, 'payout')
      sameAmount(a.amount, intent.amount)
      if (intent.collateral !== undefined)
        need(cmp(intent.amount, intent.collateral) <= 0, 'the command withdraws more than you hold')
      return {
        title: `Withdraw ${intent.amount} ${intent.marketId}`,
        lines: [
          `Pool_WithdrawCollateral: receive ${intent.amount} ${intent.marketId} from ${operator}`,
        ],
      }
    }
    case 'pause': {
      need(
        cmd.kind === 'exercise' &&
          cmd.templateId === TEMPLATES.pauseState &&
          cmd.choice === 'PauseState_SetFlag',
        'expected PauseState_SetFlag',
      )
      // The guardian sees the flags contract itself; if the server discloses it, it must be it
      for (const d of p.disclosedContracts as Obj[])
        need(
          d.contractId === cmd.contractId &&
            typeof d.templateId === 'string' &&
            /:Lending\.Pause:PauseState$/.test(d.templateId),
          'the pause command discloses other contracts',
        )
      onlyKnown(cmd.args, ['flag', 'paused'])
      need(
        cmd.args.flag === PAUSE_FLAG_CONSTRUCTORS[intent.flag] && cmd.args.paused === intent.paused,
        'the pause differs from what you chose',
      )
      return {
        title: `${intent.paused ? 'Pause' : 'Resume'}: ${PAUSE_LABELS[intent.flag].toLowerCase()}`,
        lines: [
          `${PAUSE_LABELS[intent.flag]}: ${intent.paused ? 'paused' : 'open'}`,
          'The other pauses stay as they are',
          'Supply, repayments and collateral deposits are never paused',
        ],
      }
    }
    case 'add-reserves': {
      const a = poolChoice(p, cmd, 'Pool_AddReserves', ['actor', 'amount', 'payment'])
      need(a.actor === ctx.party, 'the command acts for another party')
      sameAmount(a.amount, intent.amount)
      transferArgs(p, a.payment, intent.inputs, 'payment')
      return {
        title: `Add ${intent.amount} USDCx to protocol reserves`,
        lines: [`Pool_AddReserves: pay ${intent.amount} USDCx to ${operator}`],
      }
    }
    case 'buy-collateral': {
      const a = poolChoice(p, cmd, 'Pool_BuyCollateral', [
        'buyer',
        'pauseCid',
        'marketId',
        'amount',
        'minCollateral',
        'collateralFeedCid',
        'debtFeedCid',
        'payment',
        'payout',
      ])
      need(a.buyer === ctx.party, 'the purchase is for another buyer')
      market(a, intent.marketId)
      sameAmount(a.amount, intent.amount)
      disclosedAs(p, a.pauseCid, /:Lending\.Pause:PauseState$/, 'the pause flags')
      disclosedAs(p, a.collateralFeedCid, /:Lending\.Oracle:PriceFeed$/, 'the collateral price')
      disclosedAs(p, a.debtFeedCid, /:Lending\.Oracle:PriceFeed$/, 'the USDCx price')
      need(isDecimal(a.minCollateral), 'minimum collateral is not a decimal')
      // The server must not lower the minimum the buyer agreed to
      need(
        cmp(a.minCollateral, intent.minCollateral) >= 0,
        `the minimum ${a.minCollateral} ${intent.marketId} is below your ${intent.minCollateral}`,
      )
      transferArgs(p, a.payment, intent.inputs, 'payment')
      transferArgs(p, a.payout, undefined, 'payout')
      return {
        title: `Buy ${intent.marketId} for ${intent.amount} USDCx`,
        lines: [
          `Pool_BuyCollateral: pay ${intent.amount} USDCx to ${operator}`,
          `Receive at least ${a.minCollateral} ${intent.marketId}, or the purchase is rejected`,
        ],
      }
    }
    case 'council-propose': {
      const a = govChoice(cmd, TEMPLATES.council, intent.councilCid, 'Council_Propose', [
        'proposer',
        'proposalId',
        'description',
        'configCid',
        'newParams',
        'newMarketParams',
        'newTransferFactories',
        'expiresAt',
        'featuredAppRightChange',
        'newRoles',
      ])
      need(a.proposer === ctx.party, 'the proposal is from another party')
      need(a.proposalId === intent.proposalId, 'the proposal id differs')
      need(a.description === intent.description, 'the proposal description differs')
      need(
        typeof a.expiresAt === 'string' && Date.parse(a.expiresAt) === Date.parse(intent.expiresAt),
        'the proposal expiry differs from what you chose',
      )
      disclosedAs(p, a.configCid, /:Lending\.Config:ProtocolConfig$/, 'the protocol config')
      // This screen does not change factories or the Featured App right: the field must be empty
      need(
        a.newTransferFactories === null || a.newTransferFactories === undefined,
        'the proposal changes transfer factories',
      )
      need(
        a.featuredAppRightChange === null || a.featuredAppRightChange === undefined,
        'the proposal changes the Featured App right',
      )
      if (intent.newRoles === null)
        need(a.newRoles === null || a.newRoles === undefined, 'the proposal changes roles')
      else {
        need(intent.newRoles.operator === ctx.operator, 'the operator cannot change')
        need(
          sameRoles(a.newRoles, intent.newRoles),
          'the proposed roles differ from what you chose',
        )
      }
      const changes = checkParams(a, intent, ctx)
      return {
        title: `Propose ${intent.proposalId}`,
        lines: [
          'Council_Propose: a proposal the council approves by threshold',
          ...changes,
          ...(intent.newRoles
            ? [
                `New oracle ${short(intent.newRoles.oracle)}, guardian ${short(intent.newRoles.guardian)}, treasury ${short(intent.newRoles.treasury)}; needs the operator to execute`,
              ]
            : []),
          'Moves no funds',
        ],
      }
    }
    case 'proposal-approve': {
      const a = govChoice(cmd, TEMPLATES.proposal, intent.proposalCid, 'Proposal_Approve', [
        'approver',
      ])
      need(a.approver === ctx.party, 'the approval is for another member')
      // The contract is the one shown on the page (govChoice checked the id). The change list
      // from the API does not authorize signing: display only; the command changes only this one.
      return {
        title: 'Approve the proposal',
        lines: [
          `Proposal contract ${cidShort(intent.proposalCid)}`,
          'Proposal_Approve, moves no funds',
        ],
      }
    }
    case 'proposal-execute': {
      const a = govChoice(cmd, TEMPLATES.proposal, intent.proposalCid, 'Proposal_Execute', [
        'executor',
        'configCid',
      ])
      need(a.executor === ctx.party, 'the execution is for another member')
      disclosedAs(p, a.configCid, /:Lending\.Config:ProtocolConfig$/, 'the protocol config')
      return {
        title: 'Execute the proposal',
        lines: [
          `Proposal contract ${cidShort(intent.proposalCid)}`,
          'Proposal_Execute: apply the approved parameters',
        ],
      }
    }
    case 'proposal-withdraw': {
      const a = govChoice(cmd, TEMPLATES.proposal, intent.proposalCid, 'Proposal_Withdraw', [
        'actor',
      ])
      need(a.actor === ctx.party, 'the withdrawal is for another party')
      return { title: 'Withdraw the proposal', lines: ['Proposal_Withdraw'] }
    }
    case 'rotation-propose': {
      const a = govChoice(cmd, TEMPLATES.council, intent.councilCid, 'Council_ProposeRotation', [
        'proposer',
        'rotationId',
        'newMembers',
        'newThreshold',
        'expiresAt',
      ])
      need(a.proposer === ctx.party, 'the rotation is from another party')
      need(a.rotationId === intent.rotationId, 'the rotation id differs')
      need(sameList(a.newMembers, intent.newMembers), 'the new members differ from what you chose')
      need(String(a.newThreshold) === String(intent.newThreshold), 'the new threshold differs')
      need(
        typeof a.expiresAt === 'string' && Date.parse(a.expiresAt) === Date.parse(intent.expiresAt),
        'the rotation expiry differs from what you chose',
      )
      need(!intent.newMembers.includes(ctx.operator), 'the operator cannot be a council member')
      return {
        title: `Propose council rotation ${intent.rotationId}`,
        lines: [
          `New council of ${intent.newMembers.length}, threshold ${intent.newThreshold}`,
          'Moves no funds',
        ],
      }
    }
    case 'rotation-approve': {
      const a = govChoice(cmd, TEMPLATES.rotation, intent.rotationCid, 'Rotation_Approve', [
        'approver',
      ])
      need(a.approver === ctx.party, 'the approval is for another member')
      return { title: 'Approve the council rotation', lines: ['Rotation_Approve, moves no funds'] }
    }
    case 'rotation-join': {
      const a = govChoice(cmd, TEMPLATES.rotation, intent.rotationCid, 'Rotation_Join', ['joiner'])
      need(a.joiner === ctx.party, 'the join is for another party')
      return {
        title: 'Join the new council',
        lines: ['Rotation_Join: sign the rotation with your own key', 'Moves no funds'],
      }
    }
    case 'rotation-execute': {
      const a = govChoice(cmd, TEMPLATES.rotation, intent.rotationCid, 'Rotation_Execute', [
        'executor',
        'councilCid',
        'configCid',
        'poolCid',
      ])
      need(a.executor === ctx.party, 'the execution is for another member')
      disclosedAs(p, a.configCid, /:Lending\.Config:ProtocolConfig$/, 'the protocol config')
      disclosedAs(p, a.poolCid, /:Lending\.Pool:Pool$/, 'the pool')
      return {
        title: 'Execute the council rotation',
        lines: ['Rotation_Execute: replace the council, the config and the pool governors'],
      }
    }
    case 'rotation-withdraw': {
      const a = govChoice(cmd, TEMPLATES.rotation, intent.rotationCid, 'Rotation_Withdraw', [
        'actor',
      ])
      need(a.actor === ctx.party, 'the withdrawal is for another party')
      return { title: 'Withdraw the council rotation', lines: ['Rotation_Withdraw'] }
    }
    case 'income-propose': {
      const a = govChoice(cmd, TEMPLATES.council, intent.councilCid, 'Council_ProposeIncome', [
        'proposer',
        'proposalId',
        'treasury',
        'reservesAmount',
        'expiresAt',
      ])
      need(a.proposer === ctx.party, 'the proposal is from another party')
      need(a.proposalId === intent.proposalId, 'the proposal id differs')
      need(
        a.treasury === intent.treasury,
        'protocol income goes to another party, not the treasury',
      )
      sameAmount(a.reservesAmount, intent.reservesAmount, 'reserves amount')
      return {
        title: `Propose protocol income ${intent.proposalId}`,
        lines: [
          `To the treasury ${short(intent.treasury)}: ${intent.reservesAmount} USDCx of reserves`,
          'Paid only from non-negative reserves, after the council threshold',
        ],
      }
    }
    case 'income-approve': {
      const a = govChoice(cmd, TEMPLATES.income, intent.incomeCid, 'IncomeProposal_Approve', [
        'approver',
      ])
      need(a.approver === ctx.party, 'the approval is for another member')
      return {
        title: 'Approve the income proposal',
        lines: ['IncomeProposal_Approve, moves no funds'],
      }
    }
    case 'income-execute': {
      need(ctx.party === intent.treasury, 'only the treasury executes income proposals')
      const a = govChoice(cmd, TEMPLATES.income, intent.incomeCid, 'IncomeProposal_Execute', [
        'poolCid',
        'configCid',
        'reservesPayout',
      ])
      disclosedAs(p, a.poolCid, /:Lending\.Pool:Pool$/, 'the pool')
      disclosedAs(p, a.configCid, /:Lending\.Config:ProtocolConfig$/, 'the protocol config')
      need(isObj(a.reservesPayout), 'reserves payout is missing')
      return {
        title: 'Receive protocol income',
        lines: ['IncomeProposal_Execute: the operator pays the approved reserves to you'],
      }
    }
    case 'accept-transfer': {
      need(cmd.kind === 'exercise', 'expected TransferInstruction_Accept')
      need(cmd.templateId === TRANSFER_INSTRUCTION, 'the command targets an unknown interface')
      need(
        cmd.choice === 'TransferInstruction_Accept',
        `expected TransferInstruction_Accept, got ${cmd.choice}`,
      )
      need(cmd.contractId === intent.offerCid, 'the command accepts another transfer')
      need(
        p.disclosedContracts.length === 0,
        'accepting a transfer must not use disclosed contracts',
      )
      onlyKnown(cmd.args, ['extraArgs'])
      const extra = cmd.args.extraArgs
      need(
        isObj(extra) &&
          isObj(extra.context) &&
          isObj(extra.context.values) &&
          Object.keys(extra.context.values).length === 0 &&
          isObj(extra.meta) &&
          isObj(extra.meta.values) &&
          Object.keys(extra.meta.values).length === 0,
        'the accept carries unexpected extra arguments',
      )
      const o = intent.offer
      if (o) {
        need(o.receiver === ctx.party, 'the transfer is for another party')
        need(
          o.sender === intent.instrument.admin,
          'the transfer does not come from the token registry',
        )
        need(
          o.instrumentId.admin === intent.instrument.admin &&
            o.instrumentId.id === intent.instrument.id,
          'the transfer is of another token',
        )
        sameAmount(o.amount, intent.amount)
      }
      return {
        title: `Receive ${intent.amount} test ${intent.symbol}`,
        lines: [
          `TransferInstruction_Accept: ${intent.amount} ${intent.symbol} into your wallet`,
          o
            ? `From the token registry ${short(o.sender)}, checked on your node`
            : 'The transfer could not be read from your wallet: only the command shape is checked',
          'Moves no funds out of your wallet',
        ],
      }
    }
    case 'income-withdraw': {
      const a = govChoice(cmd, TEMPLATES.income, intent.incomeCid, 'IncomeProposal_Withdraw', [
        'actor',
      ])
      need(a.actor === ctx.party, 'the withdrawal is for another party')
      return { title: 'Withdraw the income proposal', lines: ['IncomeProposal_Withdraw'] }
    }
  }
}
