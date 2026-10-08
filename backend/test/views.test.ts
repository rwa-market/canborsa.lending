import { describe, expect, it } from 'vitest'
import type { ActiveContract } from '../src/ledger/client.ts'
import type { PriceFeedPayload, ProtocolParams } from '../src/protocol/types.ts'
import { priceView } from '../src/protocol/views.ts'

const params = {
  maxPriceAgeSeconds: '300',
  maxClockSkewSeconds: '30',
  maxSourceDeviation: '0.02',
  maxLiquidationSourceDeviation: '0.15',
} as ProtocolParams
const now = new Date('2026-09-29T12:00:00Z')
const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString()

const feed = (quotes: PriceFeedPayload['quotes']) =>
  ({
    contractId: 'f',
    payload: { oracle: 'o', instrumentId: { admin: 'a', id: 'CBTC' }, quotes, observers: [] },
  }) as unknown as ActiveContract<PriceFeedPayload>

const reason = (quotes: PriceFeedPayload['quotes']) => priceView(feed(quotes), params, now)?.reason

describe('priceView mirrors Lending.Oracle.validPrice', () => {
  it('takes the low quote for collateral and the high one for debt', () => {
    const v = priceView(
      feed([
        { source: 'a', price: '100', observedAt: at(10) },
        { source: 'b', price: '101', observedAt: at(5) },
      ]),
      params,
      now,
    )
    expect(v).toMatchObject({
      valid: true,
      collateralPrice: '100',
      debtPrice: '101',
      ageSeconds: 10,
    })
  })

  it('keeps liquidation open while sources deviate within the wider tolerance (K1)', () => {
    const at10 = priceView(
      feed([
        { source: 'a', price: '100', observedAt: at(5) },
        { source: 'b', price: '110', observedAt: at(5) },
      ]),
      params,
      now,
    )
    expect(at10).toMatchObject({ valid: false, reason: 'sources deviate', liquidationValid: true })
    const at16 = priceView(
      feed([
        { source: 'a', price: '100', observedAt: at(5) },
        { source: 'b', price: '116', observedAt: at(5) },
      ]),
      params,
      now,
    )
    expect(at16?.liquidationValid).toBe(false)
    const stale = priceView(
      feed([
        { source: 'a', price: '100', observedAt: at(301) },
        { source: 'b', price: '100', observedAt: at(5) },
      ]),
      params,
      now,
    )
    expect(stale?.liquidationValid).toBe(false)
  })

  it('needs two distinct sources and no duplicates', () => {
    expect(
      reason([
        { source: 'a', price: '100', observedAt: at(1) },
        { source: 'a', price: '100', observedAt: at(1) },
      ]),
    ).toBe('at least two distinct sources required')
    expect(
      reason([
        { source: 'a', price: '100', observedAt: at(1) },
        { source: 'b', price: '100', observedAt: at(1) },
        { source: 'a', price: '100', observedAt: at(1) },
      ]),
    ).toBe('duplicate source')
  })

  it('refuses a quote from the future beyond the clock skew, allows it at the limit', () => {
    const q = (skew: number) => [
      { source: 'a', price: '100', observedAt: at(-skew) },
      { source: 'b', price: '100', observedAt: at(1) },
    ]
    expect(reason(q(30))).toBeNull()
    expect(reason(q(31))).toBe('quote from the future')
  })

  it('is stale one second past the maximum age', () => {
    const q = (age: number) => [
      { source: 'a', price: '100', observedAt: at(age) },
      { source: 'b', price: '100', observedAt: at(1) },
    ]
    expect(reason(q(300))).toBeNull()
    expect(reason(q(301))).toBe('stale price')
  })
})
