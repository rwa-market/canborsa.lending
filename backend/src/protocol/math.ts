/**
 * Preview for the UI: the same formulas as in lending-core-v2 (Rates.daml, Risk.daml, Pool.daml).
 * The contract remains the source of truth: the preview does not authorize operations.
 */
import { Decimal } from 'decimal.js'
import type { MarketParams, PoolState, ProtocolParams, RateModel } from './types.ts'

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN })
export type Dec = InstanceType<typeof D>
export const dec = (v: string | number | Dec) => new D(v)
export const SECONDS_PER_YEAR = dec(31_536_000)
/** The smallest of the values. */
export const minOf = (first: Dec, ...rest: Dec[]) => rest.reduce((a, b) => (b.lt(a) ? b : a), first)
export const maxOf = (first: Dec, ...rest: Dec[]) => rest.reduce((a, b) => (b.gt(a) ? b : a), first)

/** U = debt / supply (getUtilization), at most 1; no supply with debt: 1. */
export function utilization(debt: Dec, supply: Dec): Dec {
  if (debt.lte(0)) return dec(0)
  if (supply.lte(0)) return dec(1)
  return Decimal.min(dec(1), debt.div(supply))
}

export function borrowRate(m: RateModel, u: Dec): Dec {
  const opt = dec(m.optimalUtilization)
  if (u.lte(opt)) return dec(m.baseRate).plus(dec(m.slope1).mul(u.div(opt)))
  return dec(m.baseRate)
    .plus(m.slope1)
    .plus(dec(m.slope2).mul(u.minus(opt).div(dec(1).minus(opt))))
}

/** Supplier rate: borrow rate × U × (1 − reserveFactor). */
export function supplyRate(m: RateModel, u: Dec): Dec {
  return borrowRate(m, u).mul(u).mul(dec(1).minus(m.reserveFactor))
}

export interface Indices {
  borrowIndex: Dec
  supplyIndex: Dec
}

/** Accrue interest up to `now`, as Lending.Rates.accrue. */
export function accrue(m: RateModel, now: Date, s: PoolState): Indices {
  const debt0 = dec(s.totalBorrowPrincipal).mul(s.borrowIndex)
  const supply0 = dec(s.totalSupplyPrincipal).mul(s.supplyIndex)
  const dt = dec(Math.max(0, now.getTime() - new Date(s.lastUpdate).getTime())).div(1000)
  if (dt.lte(0) || debt0.lte(0))
    return { borrowIndex: dec(s.borrowIndex), supplyIndex: dec(s.supplyIndex) }
  const rate = borrowRate(m, utilization(debt0, supply0))
  const growth = rate.mul(dt).div(SECONDS_PER_YEAR).exp()
  // Suppliers earn rate × min(U, 1) × (1 − reserveFactor): with debt above supply their share is
  // supply / debt of it (lending-core-v2 1.0.2)
  const share = supply0.gte(debt0) ? dec(1) : supply0.div(debt0)
  const toSuppliers = debt0.mul(growth.minus(1)).mul(dec(1).minus(m.reserveFactor)).mul(share)
  return {
    borrowIndex: dec(s.borrowIndex).mul(growth),
    supplyIndex: supply0.lte(0)
      ? dec(s.supplyIndex)
      : dec(s.supplyIndex).mul(dec(1).plus(toSuppliers.div(supply0))),
  }
}

/** Signed balance of a principal: a deposit × supplyIndex, a debt × borrowIndex (presentValue). */
export const presentValue = (principal: Dec, idx: Indices) =>
  principal.gte(0) ? principal.mul(idx.supplyIndex) : principal.mul(idx.borrowIndex)

export const poolSupply = (s: PoolState, idx: Indices) =>
  dec(s.totalSupplyPrincipal).mul(idx.supplyIndex)
export const poolDebt = (s: PoolState, idx: Indices) =>
  dec(s.totalBorrowPrincipal).mul(idx.borrowIndex)
/** cash + debt − supply (getReserves). */
export const poolReserves = (s: PoolState, idx: Indices) =>
  dec(s.cash).plus(poolDebt(s, idx)).minus(poolSupply(s, idx))

/** One collateral asset of an account with what the pool knows about it (Lending.Risk). */
export interface CollateralLine {
  marketId: string
  amount: Dec
  params: MarketParams
  /** Valid lower collateral quote; null: no valid price */
  price: Dec | null
  /** Reserve attestation fresh and sufficient, or not required */
  attested: boolean
}

/** Σ collateral × price × borrowCollateralFactor; no price or no attestation counts as zero. */
export const borrowCapacity = (ls: CollateralLine[]) =>
  ls.reduce(
    (s, l) =>
      l.price && l.attested
        ? s.plus(l.amount.mul(l.price).mul(l.params.borrowCollateralFactor))
        : s,
    dec(0),
  )

/** Σ collateral × price × liquidateCollateralFactor; null if any asset has no price. */
export function liquidationPoint(ls: CollateralLine[]): Dec | null {
  let s = dec(0)
  for (const l of ls) {
    if (!l.price) return null
    s = s.plus(l.amount.mul(l.price).mul(l.params.liquidateCollateralFactor))
  }
  return s
}

/** Σ collateral × price, zero for assets without a price; null if no asset has one. */
export function collateralValue(ls: CollateralLine[]): Dec | null {
  if (ls.length > 0 && ls.every((l) => !l.price)) return null
  return ls.reduce((s, l) => (l.price ? s.plus(l.amount.mul(l.price)) : s), dec(0))
}

/** What absorb would take from the account: penalty × collateral value at the given prices. */
export function absorbPenalty(ls: CollateralLine[]): Dec | null {
  let s = dec(0)
  for (const l of ls) {
    if (!l.price) return null
    s = s.plus(l.amount.mul(l.price).mul(dec(1).minus(l.params.liquidationFactor)))
  }
  return s
}

/** Purchase price of absorbed collateral: price × (1 − storeFrontPriceFactor × (1 − lf)). */
export const purchaseDiscount = (p: ProtocolParams, m: MarketParams) =>
  dec(p.storeFrontPriceFactor).mul(dec(1).minus(m.liquidationFactor))
export const discountedPrice = (p: ProtocolParams, m: MarketParams, price: Dec) =>
  price.mul(dec(1).minus(purchaseDiscount(p, m)))

/** Money out as a string with 10 decimals, like the token's Decimal. */
export const money = (v: Dec) => v.toFixed(10, Decimal.ROUND_DOWN)
/** User debt is rounded up: that is what they owe. */
export const moneyUp = (v: Dec) => v.toFixed(10, Decimal.ROUND_UP)
/** Signed balance: a deposit rounded down, a debt rounded up in magnitude. */
export const signedMoney = (v: Dec) => (v.gte(0) ? money(v) : `-${moneyUp(v.neg())}`)
export const ratio = (v: Dec) => v.toFixed(6, Decimal.ROUND_HALF_EVEN)

/** Mid of the feed quotes (Lending.Oracle.midPrice). */
export function midPrice(prices: (string | Dec)[]): Dec {
  const ps = prices.map((p) => dec(p))
  const lo = ps.reduce((a, b) => (b.lt(a) ? b : a))
  const hi = ps.reduce((a, b) => (b.gt(a) ? b : a))
  return lo.plus(hi).div(2)
}
