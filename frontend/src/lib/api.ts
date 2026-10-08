import type {
  AccountCommand,
  AccountView,
  AppConfig,
  BuyerView,
  CollateralQuote,
  EvmAction,
  HealthResponse,
  HistoryEntry,
  MarketId,
  Operation,
  PauseFlagName,
  PoolView,
  PreparedCommand,
  Preview,
  GovernanceRolesView,
  GovernanceView,
  TokenSymbol,
  TreasuryView,
  WalletBalances,
} from '@lending/shared'
import type { LoopPreparedResponse } from '@/wallet/loop-verify'

export class ApiError extends Error {
  readonly status: number
  /** Code of a known 0.4.0 rejection (WITHDRAWALS_WAIT_FOR_RECAPITALIZATION etc.) */
  readonly code: string | null
  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Stale command: the pool or price changed after preparation; it must be rebuilt. */
/** Stale command: a contract from the disclosure is already archived; prepare again (like CONTRACT_GONE on the backend). */
/** Pool busy with other transactions (409 locked contracts): the same command will pass a bit later. */
export const isBusy = (e: unknown) =>
  e instanceof Error && /^BUSY:|locked contracts|LOCKED_CONTRACTS/i.test(e.message)

export const isStale = (e: unknown) =>
  e instanceof Error &&
  /STALE_CONTRACT|CONTRACT_NOT_FOUND|LOCAL_VERDICT_INACTIVE|INCONSISTENT_CONTRACT|contract.*not.*(found|active)|inactive contracts|signature nonce is stale/i.test(
    e.message,
  )

/**
 * The session is an httpOnly cookie (F-15, seam 2): scripts cannot see it, the browser sends it itself
 * (`credentials: 'same-origin'`). The backend needs the X-Lending-Client header against CSRF:
 * a non-GET request by cookie without it is rejected.
 */
const CLIENT_HEADER = { 'x-lending-client': 'web' } as const

/** A session is up: a 401 on its request means it has expired (F-8). */
let sessionEpoch = 0
let sessionActive = false
export const setSessionActive = (active: boolean) => {
  sessionActive = active
  sessionEpoch++
}

/** 401 on a request of a live session: the session expired or the server changed its key (audit F-8). */
let onUnauthorized: (() => void) | null = null
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...CLIENT_HEADER }
  if (body !== undefined) headers['content-type'] = 'application/json'
  // The session the request was sent under: a response for a stale session does not reset the new one
  const epoch = sessionActive ? sessionEpoch : null
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    credentials: 'same-origin',
    body: body === undefined ? null : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
  if (res.status === 401 && epoch !== null && sessionActive && epoch === sessionEpoch)
    onUnauthorized?.()
  if (!res.ok) throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status, json.code ?? null)
  return json as T
}

/** POST /preview body. */
export interface OperationInput {
  party: string
  /** Decimal string; with `all` the snapshot amount (the backend takes the exact one) */
  amount: string
  marketId?: MarketId
  /** Withdraw all / repay all: the command carries `full: true` */
  all?: boolean
  walletAmounts?: string[]
}

/**
 * POST /loop/prepare body: the operation by EvmAction kind (K2), so repay is `supply` with
 * `full`. `amount` with full is the snapshot (the backend sets the exact cap).
 */
export type LoopPrepareInput =
  | {
      op: Exclude<EvmAction['kind'], 'deposit-collateral' | 'withdraw-collateral'>
      amount: string
      full?: boolean
    }
  | { op: 'deposit-collateral' | 'withdraw-collateral'; marketId: MarketId; amount: string }

/** Actions on an open council proposal: route POST /governance/:kind/:cid/:action. */
export type GovernanceKind = 'proposals' | 'rotations' | 'income'
export type GovernanceAction = 'approve' | 'execute' | 'join' | 'withdraw'

export interface ProposeParamsBody {
  party: string
  proposalId: string
  description: string
  expiresAt: string
  newRoles?: GovernanceRolesView
  /** Decimal ProtocolParams fields: {minLoan: "50"} */
  paramsPatch?: Record<string, string>
  /** Decimal MarketParams fields per market: {CC: {borrowCollateralFactor: "0.25"}} */
  marketParamsPatch?: Partial<Record<MarketId, Record<string, string>>>
}

export interface ProposeRotationBody {
  party: string
  rotationId: string
  newMembers: string[]
  newThreshold: number
  expiresAt: string
}

export interface ProposeIncomeBody {
  party: string
  proposalId: string
  reservesAmount: string
  expiresAt: string
}

/** POST /buyer/quote and /buyer/prepare body: USDCx to pay for absorbed collateral. */
export interface BuyerInput {
  party: string
  marketId: MarketId
  amount: string
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  config: () => request<AppConfig>('/config'),
  pool: () => request<PoolView>('/pool'),
  account: (party: string) =>
    request<{ account: AccountView | null }>(`/accounts/${encodeURIComponent(party)}`).then(
      (r) => r.account,
    ),
  wallet: (party: string) => request<WalletBalances>(`/wallet/${encodeURIComponent(party)}`),
  /** Liquidators and the backstop: absorbed collateral for sale (K5) */
  buyer: (party: string) => request<BuyerView>(`/buyer/${encodeURIComponent(party)}`),
  buyerQuote: (b: BuyerInput) => request<CollateralQuote>('/buyer/quote', b),
  prepareBuy: (b: BuyerInput & { minCollateral: string; inputHoldingCids?: string[] }) =>
    request<PreparedCommand>('/buyer/prepare', b),
  treasury: () => request<TreasuryView>('/treasury'),
  prepareAddReserves: (party: string, amount: string, inputHoldingCids?: string[]) =>
    request<PreparedCommand>('/treasury/add-reserves', { party, amount, inputHoldingCids }),
  history: (party: string) =>
    request<{ operations: HistoryEntry[] }>(`/history/${encodeURIComponent(party)}`).then(
      (r) => r.operations,
    ),
  preview: (op: Operation, input: OperationInput) => request<Preview>('/preview', { op, ...input }),
  prepare: (op: Operation | AccountCommand, input: Record<string, unknown> & { party: string }) =>
    request<PreparedCommand>(`/commands/${op}`, input),
  challenge: (party: string) =>
    request<{ nonce: string; command: PreparedCommand }>('/auth/challenge', { party }),
  /** The frontend does not need the token in the response body: the cookie carries the session */
  login: (party: string, nonce: string) =>
    request<unknown>('/auth/login', { party, nonce }).then(() => undefined),
  /** Cookie session: party and expiry, otherwise ApiError 401 */
  session: () => request<unknown>('/auth/session'),
  logout: () => request<unknown>('/auth/logout', {}).then(() => undefined),
  /** DevNet faucet: the registry offers a transfer, the user accepts it with their wallet. */
  testFaucet: (symbol: TokenSymbol) =>
    request<{
      offerCid: string
      symbol: string
      amount: string
      instrument: { admin: string; id: string }
      /** Loop account: the custodian has already credited the tokens, nothing to accept */
      received?: boolean
    }>('/faucet', { symbol }),
  /** Loop wallet login: text to sign with a nonce; party and key come from the Loop provider */
  loopChallenge: (party: string, publicKey: string) =>
    request<{ nonce: string; message: string }>('/auth/loop/challenge', { party, publicKey }),
  /** The backend checks the Ed25519 signature against publicKey; the key fingerprint must yield party */
  loopLogin: (
    party: string,
    publicKey: string,
    nonce: string,
    message: string,
    signature: string,
  ) =>
    request<unknown>('/auth/loop/login', { party, publicKey, nonce, message, signature }).then(
      () => undefined,
    ),
  /**
   * Loop wallet operation: the sealed custodian command and the text for signMessage. party is the Loop
   * party ID without the session's `loop:` prefix
   */
  loopPrepare: (party: string, input: LoopPrepareInput) =>
    request<LoopPreparedResponse>('/loop/prepare', { party, ...input }),
  /** The text goes along with the signature: the backend compares it with its own and checks the signature */
  loopSubmit: (p: LoopPreparedResponse, signature: string) =>
    request<{ updateId: string }>('/loop/submit', { ...p, signature }),
  /** Guardian: all five flags at once (PauseState_Set) */
  preparePause: (party: string, flag: PauseFlagName, paused: boolean) =>
    request<PreparedCommand>('/admin/pause', { party, flag, paused }),
  governance: () => request<GovernanceView>('/governance'),
  proposeParams: (b: ProposeParamsBody) => request<PreparedCommand>('/governance/proposals', b),
  proposeRotation: (b: ProposeRotationBody) => request<PreparedCommand>('/governance/rotations', b),
  proposeIncome: (b: ProposeIncomeBody) => request<PreparedCommand>('/governance/income', b),
  governanceAction: (
    kind: GovernanceKind,
    contractId: string,
    action: GovernanceAction,
    party: string,
  ) =>
    request<PreparedCommand>(`/governance/${kind}/${encodeURIComponent(contractId)}/${action}`, {
      party,
    }),
}

/** TanStack Query cache keys: entity → id. */
export const queryKeys = {
  config: ['config'] as const,
  pool: ['pool'] as const,
  account: (party: string | null) => ['account', party] as const,
  history: (party: string | null) => ['history', party] as const,
  wallet: (party: string | null) => ['wallet', party] as const,
  buyer: (party: string | null) => ['buyer', party] as const,
  treasury: ['treasury'] as const,
  governance: (party: string | null) => ['governance', party] as const,
  preview: (op: Operation, input: OperationInput) => ['preview', op, input] as const,
}
