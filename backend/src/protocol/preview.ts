/**
 * Operation preview before signing (Б5): the account numbers before and after, which contract checks
 * will fail. Mirrors the Pool.daml checks of lending-core-v2; the contract still decides.
 */
import { type Operation, type Preview, priceIssue } from '@lending/shared'
import type { Deployment, MarketId } from '../deployment.ts'
import {
  accrue,
  borrowCapacity,
  dec,
  type Dec,
  maxOf,
  presentValue,
  ratio,
  utilization,
} from './math.ts'
import { collateralOf, feedFor, type Snapshot } from './reader.ts'
import type { AccountPayload } from './types.ts'
import { collateralLines, debtPriceOf, poolNumbers, positionNumbers, priceView } from './views.ts'

export type PreviewOp = Operation
export type { Preview }

/**
 * F-11: "all" is not signed instantly (Loop wallet, prepare/execute). The repayment cap and the
 * operator payout are computed from indexes this far ahead: exact interest, not ×1.001.
 */
export const ALL_HORIZON_MS = 15 * 60_000

/** Why a price is not usable, for a message: ": stale price, oldest quote 6 min old". */
function priceProblem(s: Snapshot, instrument: Parameters<typeof feedFor>[1], now: Date): string {
  return `: ${priceIssue(priceView(feedFor(s, instrument), s.config.payload.params, now)) ?? 'not usable'}`
}

/** Like minOperationAmount in Pool.daml (re-audit M2): partial USDCx operations from 1 USDCx. */
const MIN_OPERATION = dec(1)
const MIN_TEXT = `Minimum is ${MIN_OPERATION.toFixed(0)} USDCx`

const pct = (v: Dec | string) => `${dec(v).mul(100).toDecimalPlaces(2).toString()}%`

/** Limit for text: without the Numeric 18 trailing zeros and with grouping, 50000.000… → 50,000. */
/**
 * Amount in a message: two decimals from 1 up, otherwise every significant digit (up to 10), so a
 * small minimum like 0.00001 CBTC is not shown as 0 (review 08.10, item 4).
 */
const show = (v: string | Dec) => {
  const x = dec(v)
  const places = x.abs().gte(1) || x.isZero() ? 2 : 10
  const [int = '0', frac = ''] = x.toDecimalPlaces(places).toFixed().split('.')
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '')
}

/** A minimum in a message: every significant digit, so it never reads lower than it is (1.004). */
const showMin = (v: string | Dec) => {
  const [int = '0', frac = ''] = dec(v).toDecimalPlaces(10).toFixed().split('.')
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '')
}

/**
 * @param amountStr decimal string or "max" (all: the whole deposit, debt or asset collateral)
 * @param walletBalance wallet balance in the operation's instrument, if known (sum of holdings)
 */
export function preview(
  d: Deployment,
  s: Snapshot,
  account: AccountPayload | null,
  op: PreviewOp,
  amountStr: string,
  marketId: MarketId | undefined,
  now: Date,
  walletBalance: Dec | null = null,
): Preview {
  const cfg = s.config.payload
  const params = cfg.params
  const flags = s.pause.payload.flags
  const n = poolNumbers(s, now)
  const isMax = amountStr === 'max'
  const blockers: string[] = []
  const warnings: string[] = []
  let moved: string | null = null
  let maxTransfer: string | null = null
  let repaysDebt: string | null = null
  const empty = {
    balance: '0.0000000000',
    borrowCapacityUsd: null,
    availableToBorrow: '0.0000000000',
    liquidationPointUsd: null,
    liquidationRisk: null,
  }
  if (!account) {
    blockers.push('Open an account first')
    return {
      before: empty,
      after: null,
      blockers,
      warnings,
      amount: null,
      all: isMax,
      maxTransfer,
      repaysDebt,
    }
  }
  if (!isMax && !dec(amountStr).gt(0)) blockers.push('Enter an amount above zero')

  const collateral = collateralOf(account)
  const balance = presentValue(dec(account.principal), n.idx)
  const deposit = balance.gt(0) ? balance : dec(0)
  const debt = balance.lt(0) ? balance.neg() : dec(0)
  const before = positionNumbers(s, d, n, balance, collateral, now)
  const checkWallet = (amount: Dec, unit: string) => {
    if (walletBalance && amount.gt(walletBalance))
      blockers.push(
        `Wallet holds ${walletBalance.toFixed(4)} ${unit}, less than ${amount.toFixed(4)}`,
      )
  }
  const negativeReserves = () => {
    if (n.netReserves.lt(0))
      blockers.push('Reserves are negative: withdrawals and loans wait for recapitalization')
  }

  let balance2 = balance
  let collateral2 = collateral
  switch (op) {
    case 'supply':
    case 'repay': {
      if (isMax) {
        // all: exactly the debt, rounded up; the balance becomes 0
        if (debt.lte(0)) blockers.push('No debt to repay')
        moved = debt.toFixed(10, 0)
        if (debt.gt(0)) {
          const later = accrue(
            params.rateModel,
            new Date(now.getTime() + ALL_HORIZON_MS),
            s.pool.payload.state,
          )
          maxTransfer = presentValue(dec(account.principal), later).neg().toFixed(10, 0)
        }
        repaysDebt = moved
        balance2 = dec(0)
        checkWallet(debt, 'USDCx')
      } else {
        const amount = dec(amountStr)
        moved = amount.toFixed(10, 1)
        if (amount.gt(0) && amount.lt(MIN_OPERATION)) blockers.push(MIN_TEXT)
        if (op === 'repay' && debt.lte(0)) blockers.push('No debt to repay')
        if (debt.gt(0)) {
          repaysDebt = (amount.lt(debt) ? amount : debt).toFixed(10, 1)
          if (amount.gt(debt))
            warnings.push(
              `The debt is repaid first; ${show(amount.minus(debt))} USDCx becomes your deposit`,
            )
        }
        balance2 = balance.plus(amount)
        checkWallet(amount, 'USDCx')
      }
      break
    }
    case 'withdraw': {
      if (deposit.lte(0)) blockers.push('Nothing supplied')
      const amount = isMax ? deposit : dec(amountStr)
      moved = amount.toFixed(10, 1)
      if (!isMax && amount.gt(deposit) && deposit.gt(0))
        blockers.push('Withdrawal exceeds your deposit: use Borrow to take a loan')
      else if (!isMax && amount.gt(0) && amount.lt(MIN_OPERATION))
        blockers.push(`${MIN_TEXT}, or withdraw everything`)
      if (flags.supplyWithdrawPaused) blockers.push('Deposit withdrawals are paused')
      if (amount.gt(n.cash)) blockers.push(`Pool liquidity is ${show(n.cash)} USDCx; withdraw less`)
      negativeReserves()
      balance2 = isMax ? dec(0) : balance.minus(amount)
      break
    }
    case 'borrow': {
      const amount = dec(isMax ? '0' : amountStr)
      moved = amount.toFixed(10, 1)
      balance2 = balance.minus(amount)
      const debt2 = balance2.lt(0) ? balance2.neg() : dec(0)
      if (amount.gt(0) && amount.lt(MIN_OPERATION)) blockers.push(MIN_TEXT)
      if (deposit.gt(0) && flags.supplyWithdrawPaused)
        blockers.push('Deposit withdrawals are paused')
      if (amount.gt(n.cash)) blockers.push('Not enough liquidity in the pool')
      negativeReserves()
      if (debt2.gt(0)) {
        if (flags.borrowPaused) blockers.push('Borrowing is paused')
        if (debt2.lt(params.minLoan))
          blockers.push(
            `Debt after the loan would be ${show(debt2)} USDCx; the minimum loan is ${showMin(params.minLoan)} USDCx`,
          )
        if (debt2.gt(params.maxDebtPerUser))
          blockers.push(`Debt per user is capped at ${show(params.maxDebtPerUser)} USDCx`)
        const added = debt2.minus(debt)
        const poolDebt2 = n.debt.plus(added)
        if (poolDebt2.gt(params.totalBorrowCap))
          blockers.push(`Protocol borrow cap ${show(params.totalBorrowCap)} USDCx reached`)
        const supply2 = n.supply.minus(deposit.gt(amount) ? amount : deposit)
        if (utilization(poolDebt2, supply2).gt(params.rateModel.maxUtilization))
          blockers.push(`Pool utilization would exceed ${pct(params.rateModel.maxUtilization)}`)
        const debtPv = priceView(feedFor(s, d.usdcx), params, now)
        if (!debtPv?.valid)
          blockers.push(`USDCx price is not valid right now${priceProblem(s, d.usdcx, now)}`)
        else if (dec(debtPv.debtPrice).minus(1).abs().gt(params.maxDebtDepeg))
          blockers.push('USDCx is off its peg: borrowing paused')
        const debtPrice = debtPriceOf(s, d, now)
        const capacity = borrowCapacity(collateralLines(s, collateral, now))
        // the debt at no less than 1 USD, as Pool_WithdrawBase values it (1.0.2)
        if (debtPrice && debt2.mul(maxOf(debtPrice, dec(1))).gt(capacity))
          blockers.push(`Not enough collateral: borrow capacity is $${show(capacity)}`)
        for (const l of before.lines) {
          if (!l.price)
            warnings.push(
              `${l.marketId} has no valid price now${priceProblem(s, l.params.collateralInstrument, now)} and adds nothing to the borrow capacity`,
            )
          else if (!l.attested)
            warnings.push(
              `${l.marketId} has no fresh proof of reserve and adds nothing to the borrow capacity`,
            )
        }
      }
      break
    }
    case 'deposit-collateral': {
      if (!marketId) {
        blockers.push('Choose an asset')
        break
      }
      const m = s.markets.get(marketId)
      const mp = s.marketParams.get(marketId)
      if (!m || !mp) {
        blockers.push('Unknown asset')
        break
      }
      const amount = dec(isMax ? '0' : amountStr)
      moved = amount.toFixed(10, 1)
      if (amount.gt(0) && amount.lt(mp.minCollateralAmount))
        blockers.push(`Minimum deposit is ${showMin(mp.minCollateralAmount)} ${marketId}`)
      const room = dec(mp.supplyCap).minus(m.totalCollateral)
      if (amount.gt(room))
        blockers.push(
          room.gt(0)
            ? `Above the ${marketId} supply cap: up to ${room.toDecimalPlaces(4, 1).toFixed(4)} ${marketId} more fits`
            : `The ${marketId} supply cap of ${show(mp.supplyCap)} is full`,
        )
      checkWallet(amount, marketId)
      collateral2 = new Map(collateral)
      collateral2.set(
        marketId,
        dec(collateral.get(marketId) ?? '0')
          .plus(amount)
          .toString(),
      )
      break
    }
    case 'withdraw-collateral': {
      if (!marketId) {
        blockers.push('Choose an asset')
        break
      }
      const mp = s.marketParams.get(marketId)
      if (!mp) {
        blockers.push('Unknown asset')
        break
      }
      const have = dec(collateral.get(marketId) ?? '0')
      const amount = isMax ? have : dec(amountStr)
      moved = amount.toFixed(10, 1)
      const left = have.minus(amount)
      if (left.lt(0)) blockers.push('Amount exceeds your collateral')
      else if (left.gt(0) && amount.gt(0) && amount.lt(mp.minCollateralAmount))
        blockers.push(
          `Minimum is ${showMin(mp.minCollateralAmount)} ${marketId}, or withdraw all of it`,
        )
      if (flags.collateralWithdrawPaused) blockers.push('Collateral withdrawals are paused')
      collateral2 = new Map(collateral)
      if (left.lte(0)) collateral2.delete(marketId)
      else collateral2.set(marketId, left.toString())
      if (debt.gt(0) && left.gte(0)) {
        const debtPv = priceView(feedFor(s, d.usdcx), params, now)
        if (!debtPv?.valid) blockers.push('USDCx price is not valid right now')
        else {
          // D-11: for collateral withdrawal the debt is valued at no less than 1 USD
          const dp = maxOf(dec(debtPv.debtPrice), dec(1))
          const capacity = borrowCapacity(collateralLines(s, collateral2, now))
          if (debt.mul(dp).gt(capacity))
            blockers.push(
              `The rest of your collateral must cover the debt: borrow capacity would be $${show(capacity)}`,
            )
        }
      }
      break
    }
  }

  const after = positionNumbers(s, d, n, balance2, collateral2, now)
  const warning = dec(params.liquidationRiskWarning)
  if (after.liquidationRisk && dec(after.liquidationRisk).gte(warning) && blockers.length === 0)
    warnings.push(
      `Liquidation risk after this is ${pct(ratio(dec(after.liquidationRisk)))}; at 100% the protocol takes all your collateral`,
    )
  const strip = (x: typeof before): Preview['before'] => ({
    balance: x.balance,
    borrowCapacityUsd: x.borrowCapacityUsd,
    availableToBorrow: x.availableToBorrow,
    liquidationPointUsd: x.liquidationPointUsd,
    liquidationRisk: x.liquidationRisk,
  })
  return {
    before: strip(before),
    after: strip(after),
    blockers,
    warnings,
    amount: moved,
    all: isMax,
    maxTransfer,
    repaysDebt,
  }
}
