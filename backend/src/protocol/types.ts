/**
 * Payload of lending-core contracts in the JSON Ledger API: numbers are strings, Map is a list of
 * pairs.
 */
import type { Instrument } from '../deployment.ts'

export type Num = string

export interface Roles {
  operator: string
  oracle: string
  guardian: string
  treasury: string
  backstop: string
  liquidators: string[]
}

export interface RateModel {
  baseRate: Num
  slope1: Num
  slope2: Num
  optimalUtilization: Num
  maxUtilization: Num
  reserveFactor: Num
}

export interface ProtocolParams {
  debtInstrument: Instrument
  rateModel: RateModel
  totalBorrowCap: Num
  maxDebtPerUser: Num
  minLoan: Num
  liquidationRiskWarning: Num
  maxPriceAgeSeconds: Num
  maxSourceDeviation: Num
  maxLiquidationSourceDeviation: Num
  maxDebtDepeg: Num
  maxClockSkewSeconds: Num
  storeFrontPriceFactor: Num
  targetReserves: Num
}

export interface MarketParams {
  collateralInstrument: Instrument
  borrowCollateralFactor: Num
  liquidateCollateralFactor: Num
  liquidationFactor: Num
  supplyCap: Num
  minCollateralAmount: Num
  requiresReserveAttestation: boolean
  minReserveCoverage: Num
  maxAttestationAgeSeconds: Num
}

export interface Market {
  /** User collateral, asset units */
  totalCollateral: Num
  /** Absorbed collateral held for sale */
  protocolCollateral: Num
  /** USDCx credited for it (book value) */
  protocolCollateralBasis: Num
}

/** Compound's totals; reserves = cash + debt − supply are not stored. */
export interface PoolState {
  totalSupplyPrincipal: Num
  totalBorrowPrincipal: Num
  supplyIndex: Num
  borrowIndex: Num
  cash: Num
  lastUpdate: string
}

export interface PauseFlags {
  borrowPaused: boolean
  collateralWithdrawPaused: boolean
  supplyWithdrawPaused: boolean
  absorbPaused: boolean
  buyPaused: boolean
}

export interface PauseStatePayload {
  operator: string
  guardian: string
  flags: PauseFlags
}

export interface ConfigPayload {
  roles: Roles
  governors: string[]
  params: ProtocolParams
  marketParams: [string, MarketParams][]
  transferFactories: [Instrument, string][]
  featuredAppRight?: string | null
  /** 0.4.0 (D-1): the DSO that grants the Featured App right */
  dso?: string | null
}

export interface PoolPayload {
  operator: string
  governors: string[]
  markets: [string, Market][]
  state: PoolState
}

export interface AccountRequestPayload {
  operator: string
  user: string
}

export interface LoginPayload {
  user: string
  operator: string
  nonce: string
  /** None on contracts from before the re-audit: the JSON API omits the field */
  expiresAt?: string | null
}

export interface AccountPayload {
  operator: string
  owner: string
  /** Signed USDCx principal: positive × supplyIndex is a deposit, negative × borrowIndex a debt */
  principal: Num
  /** Collateral per asset, asset units */
  collateral: [string, Num][]
  /** 0.5.0: EVM wallet account under the custodian `owner`; the JSON API omits None */
  evmAddress?: string | null
  /** 0.7.0: Loop wallet account under the custodian `owner`: the Loop party as text */
  loopParty?: string | null
}

/** Lending.Evm:EvmWallet (0.5.0, ADR-004). */
export interface EvmWalletPayload {
  operator: string
  custody: string
  address: string
  network: string
  /** Int arrives as a string */
  nonce: string
  balances: [{ admin: string; id: string }, Num][]
}

/** Lending.Loop:LoopWallet (0.7.0): Loop wallet account under the custodian. */
export interface LoopWalletPayload {
  operator: string
  custody: string
  /** Loop party ID as text: the party is hosted by Loop, not on our node */
  party: string
  /** Party key used to verify signatures: hex of the raw 32 Ed25519 bytes */
  publicKey: string
  network: string
  /** Int arrives as a string */
  nonce: string
  balances: [{ admin: string; id: string }, Num][]
}

/** Lending.Loop:LoopDirectory (0.7.0). */
export interface LoopDirectoryPayload {
  operator: string
  custody: string
  network: string
}

/** Lending.Account:EvmDirectory (0.5.0). */
export interface EvmDirectoryPayload {
  operator: string
  custody: string
  network: string
  addresses: { map: [string, unknown][] } | string[]
}

export interface PriceQuote {
  source: string
  price: Num
  observedAt: string
}

export interface PriceFeedPayload {
  oracle: string
  instrumentId: Instrument
  quotes: PriceQuote[]
  observers: string[]
}

export interface ReserveAttestationPayload {
  oracle: string
  instrumentId: Instrument
  coverage: Num
  attestedAt: string
  observers: string[]
}

// Council (lending-governance 0.4.0) ------------------------------------------------

export interface GovernanceCouncilPayload {
  operator: string
  members: string[]
  threshold: string
}

export interface ParameterChangeProposalPayload {
  operator: string
  members: string[]
  threshold: string
  proposalId: string
  description: string
  proposer: string
  newParams: ProtocolParams
  newMarketParams: [string, MarketParams][]
  newTransferFactories?: [Instrument, string][] | null
  expiresAt: string
  approvals: string[]
  featuredAppRightChange?: unknown
  newRoles?: Roles | null
  baseRoles?: Roles | null
  /** Risk 9: a lower liquidation factor takes effect 2 days after this */
  proposedAt: string
}

export interface CouncilRotationPayload {
  operator: string
  members: string[]
  threshold: string
  rotationId: string
  proposer: string
  newMembers: string[]
  newThreshold: string
  expiresAt: string
  approvals: string[]
  joined: string[]
}

/** Daml tuple in the JSON Ledger API: a record with fields _1, _2. */
export interface Tuple2<A, B> {
  _1: A
  _2: B
}

export interface IncomeProposalPayload {
  operator: string
  members: string[]
  threshold: string
  proposalId: string
  proposer: string
  treasury: string
  reservesAmount: Num
  expiresAt: string
  approvals: string[]
}

export interface HoldingView {
  owner: string
  instrumentId: Instrument
  amount: Num
  lock: unknown
}

export const sameInstrument = (a: Instrument, b: Instrument) => a.admin === b.admin && a.id === b.id
