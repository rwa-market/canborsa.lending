import { describe, expect, it } from 'vitest'
import {
  absorbPenalty,
  accrue,
  borrowCapacity,
  borrowRate,
  type CollateralLine,
  collateralValue,
  dec,
  discountedPrice,
  liquidationPoint,
  money,
  moneyUp,
  presentValue,
  signedMoney,
  supplyRate,
  utilization,
} from '../src/protocol/math.ts'
import type { MarketParams, PoolState, ProtocolParams, RateModel } from '../src/protocol/types.ts'

// Same values as in Lending.Types.defaultRateModel and in the Daml tests MathTest.daml
const model: RateModel = {
  baseRate: '0.02',
  slope1: '0.08',
  slope2: '0.6',
  optimalUtilization: '0.65',
  maxUtilization: '0.8',
  reserveFactor: '0.2',
}

const cc: MarketParams = {
  collateralInstrument: { admin: 'cc-admin', id: 'CC' },
  borrowCollateralFactor: '0.3',
  liquidateCollateralFactor: '0.45',
  liquidationFactor: '0.93',
  supplyCap: '400000',
  minCollateralAmount: '10',
  requiresReserveAttestation: false,
  minReserveCoverage: '1',
  maxAttestationAgeSeconds: '86400',
}
const cbtc: MarketParams = {
  ...cc,
  collateralInstrument: { admin: 'cbtc-admin', id: 'CBTC' },
  borrowCollateralFactor: '0.5',
  liquidateCollateralFactor: '0.65',
  liquidationFactor: '0.95',
  supplyCap: '0.58',
  minCollateralAmount: '0.00001',
  requiresReserveAttestation: true,
}
const params = { storeFrontPriceFactor: '0.8' } as ProtocolParams

const line = (
  m: MarketParams,
  amount: string,
  price: string | null,
  attested = true,
): CollateralLine => ({
  marketId: m.collateralInstrument.id,
  amount: dec(amount),
  params: m,
  price: price ? dec(price) : null,
  attested,
})

describe('rate model', () => {
  it('matches kink points of the contract', () => {
    expect(borrowRate(model, dec(0)).toString()).toBe('0.02')
    expect(borrowRate(model, dec('0.65')).toString()).toBe('0.1')
    expect(borrowRate(model, dec(1)).toString()).toBe('0.7')
  })

  it('control example 10: U 65%, borrow 10%, supply 5.2%', () => {
    expect(supplyRate(model, dec('0.65')).toString()).toBe('0.052')
  })

  it('utilization is debt / supply: reserves in cash do not lower it', () => {
    expect(utilization(dec(6500), dec(10000)).toString()).toBe('0.65')
    expect(utilization(dec(0), dec(0)).toString()).toBe('0')
    expect(utilization(dec(100), dec(0)).toString()).toBe('1')
    expect(utilization(dec(12000), dec(10000)).toString()).toBe('1')
  })
})

describe('accrue', () => {
  const state = (over: Partial<PoolState> = {}): PoolState => ({
    totalSupplyPrincipal: '10000',
    totalBorrowPrincipal: '6500',
    supplyIndex: '1',
    borrowIndex: '1',
    cash: '18500',
    lastUpdate: '2026-01-01T00:00:00Z',
    ...over,
  })

  it('grows debt continuously and gives suppliers 80% of the interest', () => {
    const idx = accrue(model, new Date('2027-01-01T00:00:00Z'), state())
    const debt = dec(6500).mul(idx.borrowIndex)
    const interest = debt.minus(6500)
    expect(interest.toFixed(3)).toBe('683.611')
    expect(dec(10000).mul(idx.supplyIndex).minus(10000).toFixed(3)).toBe(
      interest.mul(0.8).toFixed(3),
    )
  })

  it('does nothing without elapsed time or debt', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    expect(accrue(model, at, state()).borrowIndex.toString()).toBe('1')
    expect(
      accrue(
        model,
        new Date('2027-01-01T00:00:00Z'),
        state({ totalBorrowPrincipal: '0' }),
      ).supplyIndex.toString(),
    ).toBe('1')
  })

  it('signed balance: a deposit at the supply index, a debt at the borrow index', () => {
    const idx = { supplyIndex: dec('1.1'), borrowIndex: dec('1.2') }
    expect(presentValue(dec(100), idx).toString()).toBe('110')
    expect(presentValue(dec(-100), idx).toString()).toBe('-120')
  })
})

describe('account collateral (control example 1)', () => {
  const lines = [line(cc, '20000', '0.2'), line(cbtc, '0.1', '100000')]

  it('value 14 000, capacity 6 200, liquidation point 8 300', () => {
    expect(collateralValue(lines)!.toString()).toBe('14000')
    expect(borrowCapacity(lines).toString()).toBe('6200')
    expect(liquidationPoint(lines)!.toString()).toBe('8300')
  })

  it('risk 4: no price counts as zero for a borrow, absorb needs every price (example 8)', () => {
    const stale = [line(cc, '20000', '0.2'), line(cbtc, '0.1', null)]
    expect(borrowCapacity(stale).toString()).toBe('1200')
    expect(liquidationPoint(stale)).toBeNull()
  })

  it('no fresh attestation: CBTC adds nothing to the capacity but counts for the point', () => {
    const unattested = [line(cc, '20000', '0.2'), line(cbtc, '0.1', '100000', false)]
    expect(borrowCapacity(unattested).toString()).toBe('1200')
    expect(liquidationPoint(unattested)!.toString()).toBe('8300')
  })

  it('absorb penalty: 7% of CC, 5% of CBTC', () => {
    expect(absorbPenalty(lines)!.toString()).toBe('780')
  })
})

describe('collateral purchase (control example 5)', () => {
  it('0.13 × (1 − 0.8 × 0.07) = 0.12272; CBTC gets a 4% discount', () => {
    expect(discountedPrice(params, cc, dec('0.13')).toString()).toBe('0.12272')
    expect(discountedPrice(params, cbtc, dec(100000)).toString()).toBe('96000')
  })
})

describe('money', () => {
  it('rounds for the protocol: payouts down, debt up', () => {
    expect(money(dec('1.00000000009'))).toBe('1.0000000000')
    expect(moneyUp(dec('1.00000000001'))).toBe('1.0000000001')
    expect(signedMoney(dec('-1.00000000001'))).toBe('-1.0000000001')
    expect(signedMoney(dec('1.00000000009'))).toBe('1.0000000000')
  })
})
