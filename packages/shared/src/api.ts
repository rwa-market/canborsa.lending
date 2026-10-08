/** Read API contract (backend/src/protocol/views.ts, preview.ts). Amounts are strings. */
import type { Amount, InstrumentId } from './index.ts'

/** Collateral market. */
export type MarketId = 'CC' | 'CBTC'

/** Protocol token symbol: USDCx and collateral assets. */
export type TokenSymbol = 'USDCx' | MarketId

export interface PriceView {
  instrument: string
  collateralPrice: string
  debtPrice: string
  ageSeconds: number
  valid: boolean
  reason: string | null
  /** Usable for liquidation: source divergence tolerance is wider than for borrows (audit K1). */
  liquidationValid: boolean
}

/** Collateral asset of the pool (AssetList): three factors, a cap in asset units. */
export interface MarketView {
  marketId: MarketId
  instrument: InstrumentId
  /** Share of the collateral value that can be borrowed (Collateral Factor) */
  borrowCollateralFactor: string
  /** Debt above this share of the collateral value is absorbed (Liquidation Factor) */
  liquidateCollateralFactor: string
  /** Share of the collateral value credited on absorb */
  liquidationFactor: string
  /** 1 − liquidationFactor (Liquidation Penalty) */
  liquidationPenalty: string
  /** User collateral cap, asset units */
  supplyCap: Amount
  /** Smallest collateral deposit, asset units */
  minCollateralAmount: Amount
  /** User collateral, asset units */
  totalCollateral: Amount
  totalCollateralUsd: Amount | null
  /** Absorbed collateral held by the protocol for sale, asset units */
  protocolCollateral: Amount
  /** USDCx credited to accounts for the absorbed collateral (book value) */
  protocolCollateralBasis: Amount
  /** Buyer's discount on the oracle price: storeFrontPriceFactor × penalty */
  purchaseDiscount: string
  /** Oracle midpoint, USD; null without a feed */
  price: string | null
  requiresReserveAttestation: boolean
  reserveCoverage: string | null
}

/** Pause flags (PauseState). Supply of USDCx and of collateral is never paused. */
/** One pause flag (PauseView key) and its Lending.Pause.PauseFlag constructor (1.0.2). */
export const PAUSE_FLAG_CONSTRUCTORS = {
  borrowPaused: 'BorrowFlag',
  collateralWithdrawPaused: 'CollateralWithdrawFlag',
  supplyWithdrawPaused: 'SupplyWithdrawFlag',
  absorbPaused: 'AbsorbFlag',
  buyPaused: 'BuyFlag',
} as const
export type PauseFlagName = keyof typeof PAUSE_FLAG_CONSTRUCTORS

export interface PauseView {
  borrowPaused: boolean
  collateralWithdrawPaused: boolean
  supplyWithdrawPaused: boolean
  absorbPaused: boolean
  buyPaused: boolean
}

export interface PoolView {
  debtInstrument: InstrumentId
  totalSupplied: Amount
  totalBorrowed: Amount
  /** USDCx in the pool, reserves included */
  cash: Amount
  /** cash + debt − supply; negative after bad debt */
  reserves: Amount
  /** reserves + book value of absorbed collateral; negative closes loans and withdrawals */
  netReserves: Amount
  targetReserves: Amount
  /** Absorbed collateral is for sale while reserves are below the target */
  collateralForSale: boolean
  /** debt / supply */
  utilization: string
  /** USD value of all user collateral at the oracle price; null when no market has a price */
  totalCollateralUsd: Amount | null
  /** USDCx the pool can lend now: cash, the utilization ceiling and the total borrow cap */
  availableLiquidity: Amount
  /** Collateral value / debt (Compound's "Collateralization"); null without debt or prices */
  collateralization: string | null
  /** Annual rates, not compounded (APR) */
  borrowApr: string
  supplyApr: string
  limits: {
    totalBorrowCap: Amount
    maxDebtPerUser: Amount
    minLoan: Amount
    maxUtilization: string
    /** Liquidation risk at which the UI warns, e.g. 0.71 */
    liquidationRiskWarning: string
  }
  /** Rate model: for the rate chart */
  rateModel: {
    baseRate: string
    slope1: string
    slope2: string
    optimalUtilization: string
    maxUtilization: string
    reserveFactor: string
  }
  storeFrontPriceFactor: string
  governed: boolean
  councilSize: number
  /** The protocol creates Featured App activity markers (§10) */
  featuredApp: boolean
  pauses: PauseView
  markets: MarketView[]
  prices: Record<string, PriceView | null>
}

/** unknown: a debt whose liquidation point cannot be valued now (no usable price) */
export type AccountStatus = 'no-debt' | 'healthy' | 'warning' | 'liquidatable' | 'unknown'

/** Collateral of an account in one asset. */
export interface CollateralView {
  marketId: MarketId
  amount: Amount
  valueUsd: Amount | null
  /** The asset has a valid price now: without one it adds nothing to the borrow capacity */
  priceValid: boolean
}

/** Position Summary: the backend computes every number (rule 8). */
export interface AccountSummary {
  /** Signed USDCx balance: positive is a deposit, negative a debt */
  balance: Amount
  supplied: Amount
  borrowed: Amount
  /** Σ collateral × price */
  collateralValueUsd: Amount | null
  /** Σ collateral × price × borrow factor */
  borrowCapacityUsd: Amount | null
  /** Capacity − debt, within the caps and the pool cash, USDCx */
  availableToBorrow: Amount
  /**
   * The most a Borrow can pay out now: the deposit first, then up to `availableToBorrow` of new
   * debt, within the pool cash. The Amount field of Borrow and its Max use this, USDCx
   */
  maxBorrow: Amount
  /** Σ collateral × price × liquidation factor */
  liquidationPointUsd: Amount | null
  /** debt / liquidation point; null without debt or prices */
  liquidationRisk: string | null
  status: AccountStatus
  /** Supply APR for a deposit, minus the borrow APR for a debt */
  netApr: string | null
  /** What the account would lose if absorbed now: penalty × collateral value, USD */
  absorbPenaltyUsd: Amount | null
}

export interface AccountView {
  accountCid: string
  owner: string
  collateral: CollateralView[]
  summary: AccountSummary
}

/**
 * User operations (K2). repay is supply that pays off the debt (with all: exactly the debt);
 * withdraw never borrows, borrow is a withdrawal that may go below zero.
 */
export type Operation =
  'supply' | 'repay' | 'withdraw' | 'borrow' | 'deposit-collateral' | 'withdraw-collateral'

/** User commands without a preview. */
export type AccountCommand = 'open-account'

/** Numbers of the account before or after an operation. */
export interface PositionNumbers {
  balance: Amount
  borrowCapacityUsd: Amount | null
  availableToBorrow: Amount
  liquidationPointUsd: Amount | null
  liquidationRisk: string | null
}

export interface Preview {
  before: PositionNumbers
  /** null: the preview did not reach the result (no account, no market) */
  after: PositionNumbers | null
  blockers: string[]
  warnings: string[]
  /**
   * The amount the operation would transfer if signed now (10 places); for "all" it is the whole
   * deposit or debt. null: the preview did not reach the amount.
   */
  amount: string | null
  /** "All": the command carries `full: true`, the contract takes the exact amount at tx time */
  all: boolean
  /** Repay "all": transfer cap in the command (debt as of signature expiry); otherwise null */
  maxTransfer: string | null
  /** Supply: the part of the amount that repays debt first */
  repaysDebt: Amount | null
}

export interface PreparedCommand {
  actAs: string[]
  commands: unknown[]
  disclosedContracts: unknown[]
  /** Server signature: /dev/submit accepts only commands it built */
  seal: string
}

/** Ledger network the protocol is deployed on (backend LEDGER_NETWORK). */
export type LedgerNetwork = 'devnet' | 'testnet' | 'mainnet'

/**
 * Expected wallet network (agreement §10): the frontend checks it fail-closed before signing
 * Login. `networkId` is the CIP-0103 networkId, `synchronizerId` is the pool synchronizer.
 */
export interface NetworkInfo {
  name: LedgerNetwork
  networkId: string | null
  synchronizerId: string | null
}

export interface AppConfig {
  instruments: {
    usdcx: InstrumentId
    cc: InstrumentId
    cbtc: InstrumentId
  }
  /** Collateral markets */
  markets: MarketId[]
  /** Roles from ProtocolConfig on the ledger (re-read); without a ledger, from deployment.json. */
  roles: {
    operator: string
    guardian: string
    treasury: string
    liquidator: string
    backstop: string
    /** All liquidators from ProtocolConfig.roles.liquidators */
    liquidators?: string[]
  }
  /** Test token faucet for the signed-in party (POST /faucet): DevNet only */
  testFaucet?: boolean
  /** Expected wallet network; null means do not check */
  networkId: string | null
  /** The same plus the pool synchronizer; the frontend checks before signing Login (§10) */
  network?: NetworkInfo
  /**
   * EVM wallet sign-in (0.5.0, ADR-004): if present, the account opens under the custodian,
   * ops are signed with personal_sign, verified by the contract. No key: disabled (EVM_WALLETS).
   */
  evm?: { network: string; custody: string } | null
  /**
   * Loop wallet sign-in (0.7.0, LOOP_WALLETS): `loop.init` parameters for the frontend. The
   * account is LoopWallet under the custodian, ops signed via `provider.signMessage`, signature
   * is verified by the backend. enabled=false or no field: no Loop button.
   */
  loop?: LoopConfig
  /**
   * Real assets (REAL_ASSETS, ASSET_PROFILE=real; testnet/mainnet only). No field:
   * test profile: DevNet and test tokens, show nothing new.
   */
  realAssets?: RealAssetsInfo
}

/** /config.realAssets: public fields only, no secrets or URLs with keys. */
export interface RealAssetsInfo {
  enabled: boolean
  profile: 'real'
  /** Profile instruments by slot: usdcx, cc, cbtc */
  instruments: Record<string, InstrumentId>
  /** Custodian party: receiver of CC/CBTC and USDCx deposits */
  custody: string
  /** deposit memo: `${depositReasonPrefix}${address}` */
  depositReasonPrefix: string
  /** USDCx deposit via xReserve; null means claim is disabled (no ETH_RPC_URL) */
  xreserve: {
    chainId: number
    contract: string
    usdc: string
    cantonDomain: number
    /** The xReserve deposit receiver is the custodian party */
    recipient: string
    /** Fee cap in USDC units (6 places) */
    maxFee: string
  } | null
}

/** POST /evm/claim-deposit: result of the xReserve deposit check. */
export interface ClaimDepositResponse {
  txHash: string
  /** Deposit amount, USDC */
  amount: string
  /** credited: credited to the wallet; minted: minted to the custodian, awaiting credit */
  status: 'credited' | 'minted'
}

/** POST /… response: a contract refusal with a code (0.4.0); the frontend shows an explanation. */
export interface ApiErrorBody {
  error: string
  /** Known refusal code: WITHDRAWALS_WAIT_FOR_RECAPITALIZATION, INSURANCE_FUND_BELOW_MINIMUM… */
  code?: string
}

// Council (lending-governance 0.4.0) ------------------------------------------------

export interface GovernanceRolesView {
  operator: string
  oracle: string
  guardian: string
  treasury: string
  backstop: string
  liquidators: string[]
}

/**
 * What the proposal would change if executed now: the new value against the current
 * config. Display only: signing is authorized by the command the verifier checks.
 */
export interface GovernanceChange {
  scope: 'protocol' | 'market' | 'roles' | 'factories' | 'featuredAppRight'
  /** Market (scope market) or instrument `admin::id` (scope factories); otherwise null */
  target: string | null
  /** Dotted field path: `rateModel.slope1`, `ltv`, `guardian`; '' means the whole market/factory */
  field: string
  /** Current value; null if absent now (new market or factory) */
  from: string | null
  /** New value; null means it will be removed */
  to: string | null
}

export interface GovernanceProposalView {
  contractId: string
  proposalId: string
  description: string
  proposer: string
  expiresAt: string
  /** A lower liquidation factor executes from this time (2 days after the proposal); null: at once */
  executableAfter: string | null
  approvals: string[]
  /** How many approvals execution needs (council threshold at proposal time) */
  threshold: number
  /** Needs operator signature: roles, factories, Featured App right, disabling attestation */
  trusted: boolean
  newRoles: GovernanceRolesView | null
  /** Differences from the current config; an empty list means the proposal changes nothing */
  changes: GovernanceChange[]
}

export interface CouncilRotationView {
  contractId: string
  rotationId: string
  proposer: string
  members: string[]
  newMembers: string[]
  newThreshold: number
  /** How many approvals from the current council are needed */
  threshold: number
  expiresAt: string
  approvals: string[]
  joined: string[]
  /** First council of external parties (members = []) */
  formation: boolean
}

export interface IncomeProposalView {
  contractId: string
  proposalId: string
  proposer: string
  treasury: string
  reservesAmount: Amount
  expiresAt: string
  approvals: string[]
  /** How many approvals are needed */
  threshold: number
}

/** GET /governance response: council, open proposals, rotations and reserve withdrawals. */
/**
 * A council of one BitSafe Decentralized Party (review 03.10, item 25): its GovernanceRules
 * members and threshold, and the DecMan actions waiting for confirmations. Votes happen in the
 * Decentralization Manager on each member's node; this page only shows them.
 */
export interface DecManCouncilView {
  governanceParty: string
  members: string[]
  threshold: number
  actions: {
    contractId: string
    label: string
    description: string
    proposer: string
    /** members who confirmed and whose confirmation has not expired */
    confirmations: string[]
  }[]
}

export interface GovernanceView {
  council: { contractId: string; members: string[]; threshold: number } | null
  /** null: the council is not a Decentralized Party, or this backend's node does not host it */
  decman: DecManCouncilView | null
  roles: GovernanceRolesView
  proposals: GovernanceProposalView[]
  rotations: CouncilRotationView[]
  income: IncomeProposalView[]
}

/** GET /accounts/:party response. */
export interface AccountResponse {
  account: AccountView | null
}

/** GET /history/:party response. */
export interface HistoryResponse {
  operations: HistoryEntry[]
}

/** Bot state for /health/ready (B-10). */
export interface BotStatus {
  name: string
  state: 'starting' | 'ok' | 'error' | 'stopped'
  lastRunAt: string | null
  lastSuccessAt: string | null
  consecutiveFailures: number
  lastError: string | null
}

/** GET /health/ready response: 200 means ready, 503 means there are problems from `problems`. */
export interface ReadinessResponse {
  ready: boolean
  problems: string[]
  ledger: 'connected' | 'unavailable'
  credentials: Record<string, { ok: boolean; error: string | null }>
  bots: BotStatus[]
  /** Age of the feed's oldest quote, seconds; null if there is no feed or the bot cannot see it */
  priceAgeSeconds: Record<string, number | null>
  /** ledger-end minus the indexer checkpoint; null if the indexer is not in this process */
  indexerLag: number | null
  /** Age of the CBTC reserve attestation, seconds */
  attestationAgeSeconds: number | null
  /** N5: free backstop USDCx; null if the process has no backstop user */
  backstopBalance: string | null
}

/** Absorbed collateral for sale, as an approved buyer sees it: no account or party (privacy §9). */
export interface CollateralSaleView {
  marketId: MarketId
  /** Absorbed collateral the protocol holds, asset units */
  available: Amount
  /** Oracle midpoint, USD; null without a usable price */
  marketPrice: string | null
  /** Purchase price, USDCx per unit: midpoint × (1 − discount); null without a usable price */
  price: string | null
  discount: string
  /** USDCx that buys everything available */
  costOfAll: Amount | null
}

/** GET /buyer/:party: liquidators and the backstop buy absorbed collateral (K5). */
export interface BuyerView {
  role: 'liquidator' | 'backstop'
  /** Reserves below the target: the collateral is for sale */
  forSale: boolean
  reserves: Amount
  targetReserves: Amount
  buyPaused: boolean
  collateral: CollateralSaleView[]
  wallet: WalletBalances
}

/** POST /buyer/quote: what `amount` USDCx buys now. */
export interface CollateralQuote {
  marketId: MarketId
  pay: Amount
  receive: Amount
  /**
   * Default minimum to receive: receive × (1 − BUY_TOLERANCE), rounded down, as the buyer bots set
   * it. An exact quote as the minimum fails on any price move before execution.
   */
  minReceive: Amount
  price: string
}

/** Reserves for treasury and guardian (K6). */
export interface TreasuryView {
  reserves: Amount
  netReserves: Amount
  targetReserves: Amount
  cash: Amount
  treasuryUsdcx: Amount
  backstopUsdcx: Amount
  /** Absorbed collateral per asset: amount and book value */
  collateralBook: { marketId: MarketId; amount: Amount; basis: Amount }[]
}

/** Free wallet balance by instrument symbol, decimal strings. */
/** Free tokens by symbol; a market missing from the deployment gives "0.0000000000". */
export type WalletBalances = Record<TokenSymbol, string>

/** History events by Compound's names (Б7). */
export type HistoryOp =
  | 'supply'
  | 'withdraw'
  | 'deposit-collateral'
  | 'withdraw-collateral'
  | 'absorb'
  | 'buy-collateral'
  | 'add-reserves'
  | 'withdraw-reserves'
  | 'open-account'

export interface HistoryEntry {
  updateId: string
  nodeId: number
  offset: number
  effectiveAt: string
  party: string
  op: HistoryOp
  marketId: MarketId | null
  /**
   * Executed amount: USDCx for supply and withdraw (a withdraw that borrows included), collateral
   * units for collateral operations; for absorb, the debt written off
   */
  amount: Amount | null
  /** Absorb: USDCx credited to the account for its collateral */
  credited?: Amount | null
  /** Absorb: collateral taken per asset */
  collateralTaken?: { marketId: MarketId; amount: Amount }[] | null
  /**
   * Absorb: what stayed on the balance, credited − debt, never below 0: when the collateral does
   * not cover the debt the contract zeroes the account (Pool_Absorb). The UI shows it as is
   */
  balanceAfter?: Amount | null
  /** Absorb: the part of the debt the collateral did not cover, written off by the protocol */
  writtenOff?: Amount | null
  /** Supply that repaid debt / withdraw that borrowed: the debt part of `amount` */
  debtPart?: Amount | null
}

/** /config.loop: what the frontend needs for `loop.init`. */
export interface LoopConfig {
  enabled: boolean
  /** Loop SDK network */
  network: 'devnet' | 'testnet' | 'mainnet'
  /** appName for `loop.init` */
  appName: string
  /** Custodian of Loop accounts; null means disabled */
  custody: string | null
}
