import { Decimal } from 'decimal.js'
/** Read API responses: amounts as strings, the backend computes every number (rule 8). */
import type {
  AccountStatus,
  AccountSummary,
  AccountView,
  CollateralSaleView,
  MarketView,
  PoolView,
  PositionNumbers,
  PriceView,
} from '@lending/shared'
import type { Deployment, MarketId } from '../deployment.ts'
import { instrumentsOf, MARKETS } from '../deployment.ts'
import type { ActiveContract } from '../ledger/client.ts'
import {
  absorbPenalty,
  accrue,
  borrowCapacity,
  borrowRate,
  type CollateralLine,
  collateralValue,
  dec,
  type Dec,
  discountedPrice,
  type Indices,
  liquidationPoint,
  maxOf,
  midPrice,
  minOf,
  money,
  moneyUp,
  poolDebt,
  poolReserves,
  poolSupply,
  presentValue,
  purchaseDiscount,
  ratio,
  signedMoney,
  supplyRate,
  utilization,
} from './math.ts'
import { attestationFor, collateralOf, feedFor, type Snapshot } from './reader.ts'
import type {
  AccountPayload,
  MarketParams,
  PriceFeedPayload,
  ProtocolParams,
  ReserveAttestationPayload,
} from './types.ts'

export type { PriceView }

/**
 * Price as Lending.Oracle.validPrice sees it (audit S4, re-audit): two different sources, no
 * duplicates, no quote from the future beyond maxClockSkewSeconds and none older than
 * maxPriceAgeSeconds, deviation at most maxSourceDeviation. The order of checks is the same as in
 * the contract, so the reason matches the rejection text. `liquidationValid`: the same for
 * validLiquidationPrice, with a wider deviation tolerance (audit K1).
 */
export function priceView(
  feed: ActiveContract<PriceFeedPayload> | undefined,
  p: ProtocolParams,
  now: Date,
): PriceView | null {
  if (!feed || feed.payload.quotes.length === 0) return null
  const quotes = feed.payload.quotes
  const prices = quotes.map((q) => dec(q.price))
  const lo = prices.reduce((a, b) => (a.lt(b) ? a : b))
  const hi = prices.reduce((a, b) => (a.gt(b) ? a : b))
  // seconds from the quote to now: positive is in the past, negative is from the future
  const ages = quotes.map((q) => dec(now.getTime() - new Date(q.observedAt).getTime()).div(1000))
  const oldest = ages.reduce((a, b) => (a.gt(b) ? a : b))
  const newest = ages.reduce((a, b) => (a.lt(b) ? a : b))
  const distinct = new Set(quotes.map((q) => q.source)).size
  const reasonWith = (maxDeviation: string) =>
    distinct < 2
      ? 'at least two distinct sources required'
      : distinct !== quotes.length
        ? 'duplicate source'
        : newest.neg().gt(p.maxClockSkewSeconds)
          ? 'quote from the future'
          : oldest.gt(p.maxPriceAgeSeconds)
            ? 'stale price'
            : hi.minus(lo).div(lo).gt(maxDeviation)
              ? 'sources deviate'
              : null
  const reason = reasonWith(p.maxSourceDeviation)
  return {
    instrument: feed.payload.instrumentId.id,
    collateralPrice: lo.toString(),
    debtPrice: hi.toString(),
    ageSeconds: Math.max(0, Math.round(oldest.toNumber())),
    valid: reason === null,
    reason,
    liquidationValid: reasonWith(p.maxLiquidationSourceDeviation) === null,
  }
}

/** Reserve attestation fresh and sufficient (Lending.Oracle.checkReserve), or not required. */
export function attested(
  mp: MarketParams,
  att: ActiveContract<ReserveAttestationPayload> | undefined,
  oracle: string,
  now: Date,
): boolean {
  if (!mp.requiresReserveAttestation) return true
  if (!att || att.payload.oracle !== oracle) return false
  const age = (now.getTime() - new Date(att.payload.attestedAt).getTime()) / 1000
  return (
    age <= Number(mp.maxAttestationAgeSeconds) &&
    dec(att.payload.coverage).gte(mp.minReserveCoverage)
  )
}

/**
 * Collateral lines of an account as the contract builds them for a borrow (borrowLines): the
 * lower valid quote or no price, attestation for CBTC. `liquidation`: the absorb tolerance.
 */
export function collateralLines(
  s: Snapshot,
  collateral: Map<string, string>,
  now: Date,
  liquidation = false,
): CollateralLine[] {
  const cfg = s.config.payload
  const lines: CollateralLine[] = []
  for (const [marketId, amount] of collateral) {
    const mp = s.marketParams.get(marketId)
    if (!mp || dec(amount).lte(0)) continue
    const pv = priceView(feedFor(s, mp.collateralInstrument), cfg.params, now)
    const ok = pv && (liquidation ? pv.liquidationValid : pv.valid)
    lines.push({
      marketId,
      amount: dec(amount),
      params: mp,
      price: ok ? dec(pv.collateralPrice) : null,
      attested: attested(mp, attestationFor(s, mp.collateralInstrument), cfg.roles.oracle, now),
    })
  }
  return lines
}

/** Valid higher USDCx quote, or null. */
export function debtPriceOf(s: Snapshot, d: Deployment, now: Date): Dec | null {
  const pv = priceView(feedFor(s, d.usdcx), s.config.payload.params, now)
  return pv?.valid ? dec(pv.debtPrice) : null
}

export function marketView(s: Snapshot, id: MarketId, now: Date): MarketView | null {
  const cfg = s.config.payload
  const m = s.markets.get(id)
  const mp = s.marketParams.get(id)
  if (!m || !mp) return null
  const feed = feedFor(s, mp.collateralInstrument)
  const pv = priceView(feed, cfg.params, now)
  const att = attestationFor(s, mp.collateralInstrument)
  return {
    marketId: id,
    instrument: mp.collateralInstrument,
    borrowCollateralFactor: mp.borrowCollateralFactor,
    liquidateCollateralFactor: mp.liquidateCollateralFactor,
    liquidationFactor: mp.liquidationFactor,
    liquidationPenalty: ratio(dec(1).minus(mp.liquidationFactor)),
    supplyCap: money(dec(mp.supplyCap)),
    minCollateralAmount: money(dec(mp.minCollateralAmount)),
    totalCollateral: money(dec(m.totalCollateral)),
    totalCollateralUsd: pv ? money(dec(m.totalCollateral).mul(pv.collateralPrice)) : null,
    protocolCollateral: money(dec(m.protocolCollateral)),
    protocolCollateralBasis: money(dec(m.protocolCollateralBasis)),
    purchaseDiscount: ratio(purchaseDiscount(cfg.params, mp)),
    price: feed ? midPrice(feed.payload.quotes.map((q) => q.price)).toString() : null,
    requiresReserveAttestation: mp.requiresReserveAttestation,
    reserveCoverage: att ? att.payload.coverage : null,
  }
}

/** Pool numbers at `now`: indices, totals, reserves, utilization. */
export function poolNumbers(s: Snapshot, now: Date) {
  const st = s.pool.payload.state
  const idx = accrue(s.config.payload.params.rateModel, now, st)
  const debt = poolDebt(st, idx)
  const supply = poolSupply(st, idx)
  const reserves = poolReserves(st, idx)
  const basis = [...s.markets.values()].reduce(
    (sum, m) => sum.plus(m.protocolCollateralBasis),
    dec(0),
  )
  return {
    idx,
    debt,
    supply,
    cash: dec(st.cash),
    reserves,
    netReserves: reserves.plus(basis),
    utilization: utilization(debt, supply),
  }
}

export function poolView(d: Deployment, s: Snapshot, now: Date): PoolView {
  const cfg = s.config.payload
  const n = poolNumbers(s, now)
  const m = cfg.params.rateModel
  const prices = Object.fromEntries(
    Object.values(instrumentsOf(d)).map((i) => [i.id, priceView(feedFor(s, i), cfg.params, now)]),
  )
  const markets = MARKETS.map((id) => marketView(s, id, now)).filter((x) => x !== null)
  const valued = markets.filter((x) => x.totalCollateralUsd !== null)
  const collateralUsd = valued.length
    ? valued.reduce((a, x) => a.plus(x.totalCollateralUsd!), dec(0))
    : null
  const liquidity = maxOf(
    dec(0),
    minOf(
      n.cash,
      dec(m.maxUtilization).mul(n.supply).minus(n.debt),
      dec(cfg.params.totalBorrowCap).minus(n.debt),
    ),
  )
  return {
    debtInstrument: cfg.params.debtInstrument,
    totalSupplied: money(n.supply),
    totalBorrowed: moneyUp(n.debt),
    cash: money(n.cash),
    reserves: signedMoney(n.reserves),
    netReserves: signedMoney(n.netReserves),
    targetReserves: money(dec(cfg.params.targetReserves)),
    collateralForSale: n.reserves.lt(cfg.params.targetReserves),
    utilization: ratio(n.utilization),
    totalCollateralUsd: collateralUsd ? money(collateralUsd) : null,
    availableLiquidity: money(liquidity),
    collateralization: collateralUsd && n.debt.gt(0) ? ratio(collateralUsd.div(n.debt)) : null,
    borrowApr: ratio(borrowRate(m, n.utilization)),
    supplyApr: ratio(supplyRate(m, n.utilization)),
    limits: {
      totalBorrowCap: money(dec(cfg.params.totalBorrowCap)),
      maxDebtPerUser: money(dec(cfg.params.maxDebtPerUser)),
      minLoan: money(dec(cfg.params.minLoan)),
      maxUtilization: m.maxUtilization,
      liquidationRiskWarning: cfg.params.liquidationRiskWarning,
    },
    rateModel: {
      baseRate: m.baseRate,
      slope1: m.slope1,
      slope2: m.slope2,
      optimalUtilization: m.optimalUtilization,
      maxUtilization: m.maxUtilization,
      reserveFactor: m.reserveFactor,
    },
    storeFrontPriceFactor: cfg.params.storeFrontPriceFactor,
    governed: cfg.governors.length > 0,
    councilSize: cfg.governors.length,
    featuredApp: s.featuredAppRight !== null,
    pauses: { ...s.pause.payload.flags },
    markets,
    prices,
  }
}

/**
 * How much new debt the pool lets this account take now: cash, the utilization ceiling, the pool
 * cap and the per-user cap. A borrow pays the account's deposit out first, so the deposit leaves
 * both the cash and the supply before the new debt is counted, as the preview checks it (review
 * 08.10, item 3). The hint must not promise more than the contract accepts.
 */
function poolHeadroom(
  s: Snapshot,
  n: ReturnType<typeof poolNumbers>,
  userDebt: Dec,
  deposit: Dec,
): Dec {
  const p = s.config.payload.params
  return minOf(
    n.cash.minus(deposit),
    dec(p.rateModel.maxUtilization).mul(n.supply.minus(deposit)).minus(n.debt),
    dec(p.totalBorrowCap).minus(n.debt),
    dec(p.maxDebtPerUser).minus(userDebt),
  )
}

/** Numbers of an account with a given balance and collateral (Position Summary). */
export function positionNumbers(
  s: Snapshot,
  d: Deployment,
  n: ReturnType<typeof poolNumbers>,
  balance: Dec,
  collateral: Map<string, string>,
  now: Date,
): PositionNumbers & { lines: CollateralLine[]; debt: Dec; risk: Dec | null } {
  const lines = collateralLines(s, collateral, now)
  const debt = balance.lt(0) ? balance.neg() : dec(0)
  const deposit = balance.gt(0) ? balance : dec(0)
  const debtPrice = debtPriceOf(s, d, now)
  const capacity = borrowCapacity(lines)
  // the contract values a borrow's debt at no less than 1 USD (1.0.2)
  const capacityUsdcx = debtPrice ? capacity.div(maxOf(debtPrice, dec(1))) : null
  const available = capacityUsdcx
    ? maxOf(dec(0), minOf(capacityUsdcx.minus(debt), poolHeadroom(s, n, debt, deposit)))
    : dec(0)
  // The liquidation point and risk use the prices Pool_Absorb accepts (the wider source tolerance),
  // so the screen says "liquidatable" exactly when the absorber can act
  const point = liquidationPoint(collateralLines(s, collateral, now, true))
  const debtPv = priceView(feedFor(s, d.usdcx), s.config.payload.params, now)
  const absorbDebtPrice = debtPv?.liquidationValid ? dec(debtPv.debtPrice) : null
  const risk =
    debt.gt(0) && point && absorbDebtPrice
      ? point.isZero()
        ? dec(1)
        : debt.mul(absorbDebtPrice).div(point)
      : null
  return {
    balance: signedMoney(balance),
    borrowCapacityUsd: money(capacity),
    availableToBorrow: money(available),
    liquidationPointUsd: point ? money(point) : null,
    liquidationRisk: risk ? ratio(risk) : null,
    lines,
    debt,
    risk,
  }
}

/**
 * The most one Borrow pays out (review 08.10, item 3): the deposit first (Pool_WithdrawBase), then
 * the new debt available. New debt that would leave the total under minLoan cannot be taken, so
 * then only the deposit is paid. Never more than the pool cash.
 */
function maxBorrowOf(
  balance: Dec,
  available: Dec,
  debt: Dec,
  cash: Dec,
  p: { minLoan: string },
): Dec {
  const deposit = maxOf(balance, dec(0))
  const newDebt = debt.plus(available).lt(p.minLoan) ? dec(0) : available
  return maxOf(dec(0), minOf(deposit.plus(newDebt), cash))
}

export function accountView(
  d: Deployment,
  s: Snapshot,
  account: ActiveContract<AccountPayload> | null,
  now: Date,
): AccountView | null {
  if (!account) return null
  const cfg = s.config.payload
  const n = poolNumbers(s, now)
  const balance = presentValue(dec(account.payload.principal), n.idx)
  const collateral = collateralOf(account.payload)
  const pos = positionNumbers(s, d, n, balance, collateral, now)
  const value = collateralValue(pos.lines)
  const warning = dec(cfg.params.liquidationRiskWarning)
  // From the unrounded risk: 1.0000004 is liquidatable, not "warning" (the ratio string rounds)
  const risk = pos.risk
  const status: AccountStatus = pos.debt.lte(0)
    ? 'no-debt'
    : risk === null
      ? 'unknown'
      : risk.gt(1)
        ? 'liquidatable'
        : risk.gte(warning)
          ? 'warning'
          : 'healthy'
  const m = cfg.params.rateModel
  const netApr = balance.gt(0)
    ? supplyRate(m, n.utilization)
    : balance.lt(0)
      ? borrowRate(m, n.utilization).neg()
      : null
  const penalty = absorbPenalty(pos.lines)
  const summary: AccountSummary = {
    balance: pos.balance,
    supplied: money(balance.gt(0) ? balance : dec(0)),
    borrowed: moneyUp(pos.debt),
    collateralValueUsd: value ? money(value) : null,
    borrowCapacityUsd: pos.borrowCapacityUsd,
    availableToBorrow: pos.availableToBorrow,
    maxBorrow: money(
      maxBorrowOf(balance, dec(pos.availableToBorrow), pos.debt, n.cash, cfg.params),
    ),
    liquidationPointUsd: pos.liquidationPointUsd,
    liquidationRisk: pos.liquidationRisk,
    status,
    netApr: netApr ? ratio(netApr) : null,
    absorbPenaltyUsd: pos.debt.gt(0) && penalty ? money(penalty) : null,
  }
  return {
    accountCid: account.contractId,
    owner: account.payload.owner,
    collateral: MARKETS.filter((id) => collateral.has(id)).map((marketId) => {
      const line = pos.lines.find((l) => l.marketId === marketId)
      const amount = dec(collateral.get(marketId) ?? '0')
      return {
        marketId,
        amount: money(amount),
        valueUsd: line?.price ? money(amount.mul(line.price)) : null,
        priceValid: !!line?.price,
      }
    }),
    summary,
  }
}

/** Accrued indices of the snapshot: for commands and bots. */
export const indicesAt = (s: Snapshot, now: Date): Indices =>
  accrue(s.config.payload.params.rateModel, now, s.pool.payload.state)

/**
 * Absorbed collateral for sale as a buyer sees it (K5): the midpoint × (1 − discount), quoted in
 * USDCx at the USDCx midpoint, as Pool_BuyCollateral. No usable price: no purchase price.
 */
export function saleView(
  s: Snapshot,
  d: Deployment,
  id: MarketId,
  now: Date,
): CollateralSaleView | null {
  const cfg = s.config.payload
  const m = s.markets.get(id)
  const mp = s.marketParams.get(id)
  if (!m || !mp) return null
  const feed = feedFor(s, mp.collateralInstrument)
  const debtFeed = feedFor(s, d.usdcx)
  const pv = priceView(feed, cfg.params, now)
  const dv = priceView(debtFeed, cfg.params, now)
  const usable = feed && debtFeed && pv?.liquidationValid && dv?.liquidationValid
  const mid = feed ? midPrice(feed.payload.quotes.map((q) => q.price)) : null
  const price =
    usable && mid
      ? discountedPrice(cfg.params, mp, mid).div(
          midPrice(debtFeed.payload.quotes.map((q) => q.price)),
        )
      : null
  const available = dec(m.protocolCollateral)
  return {
    marketId: id,
    available: money(available),
    marketPrice: mid ? mid.toString() : null,
    price: price ? price.toString() : null,
    discount: ratio(purchaseDiscount(cfg.params, mp)),
    costOfAll: usable && mid ? contractWholeCost(cfg.params, mp, feed, debtFeed, available) : null,
  }
}

/** Numeric 18 as Daml rounds it: mulN / divN half-even, mulUp / divUp up. */
const r18 = (v: Dec) => v.toDecimalPlaces(18, Decimal.ROUND_HALF_EVEN)
const up18 = (v: Dec) => v.toDecimalPlaces(18, Decimal.ROUND_UP)

/**
 * The whole stock's cost exactly as Pool_BuyCollateral computes `wholeCost` (review follow-up):
 * mid and discount at 18 decimals half-even, stock × price and ÷ USDCx mid rounded up, then up to
 * the token's 10 decimals. Paying it buys the whole stock; one unit more is refused.
 */
function contractWholeCost(
  params: ProtocolParams,
  mp: MarketParams,
  feed: ActiveContract<PriceFeedPayload>,
  debtFeed: ActiveContract<PriceFeedPayload>,
  stock: Dec,
): string {
  const midOf = (f: ActiveContract<PriceFeedPayload>) => {
    const ps = f.payload.quotes.map((q) => dec(q.price))
    return r18(
      minOf(ps[0]!, ...ps.slice(1))
        .plus(maxOf(ps[0]!, ...ps.slice(1)))
        .div(2),
    )
  }
  const discount = r18(dec(params.storeFrontPriceFactor).mul(dec(1).minus(mp.liquidationFactor)))
  const price = r18(midOf(feed).mul(r18(dec(1).minus(discount))))
  return moneyUp(up18(up18(stock.mul(price)).div(midOf(debtFeed))))
}

/**
 * What `amount` USDCx buys now, as Pool_BuyCollateral (1.0.2) computes it: rounded down, but paying
 * `costOfAll` buys the whole stock, and a rest worth less than one USDCx unit goes with the purchase.
 */
export function quoteCollateral(sale: CollateralSaleView, amount: string): string | null {
  if (!sale.price) return null
  const available = dec(sale.available)
  if (sale.costOfAll && dec(amount).gte(sale.costOfAll)) return money(available)
  const out = dec(money(dec(amount).div(sale.price)))
  const rest = available.minus(out)
  if (rest.gt(0) && rest.mul(sale.price).lt('0.0000000001')) return money(available)
  return money(out)
}
