import { describe, expect, it } from 'vitest'
import { formatAmount, formatPercent, formatUsd, isNegative, middleParty } from './amount'

describe('middleParty', () => {
  it('keeps the start and the end of the whole id, past the namespace separator', () => {
    expect(middleParty('6c731abb9c0340f580ac2a30f1d2a30f::1220abcd')).toBe('6c73…abcd')
  })
  it('leaves a short id as is', () => {
    expect(middleParty('alice::12')).toBe('alice::12')
  })
})

describe('signed balance (K1)', () => {
  it('a minus is a debt, minus zero is not', () => {
    expect(isNegative('-5.00')).toBe(true)
    expect(isNegative('-0.0000')).toBe(false)
    expect(isNegative('5')).toBe(false)
    expect(isNegative(null)).toBe(false)
  })
  it('formats the sign before the dollar, truncating', () => {
    expect(formatUsd('-1200.129')).toBe('−$1,200.12')
    expect(formatUsd('14000')).toBe('$14,000.00')
    expect(formatUsd(null)).toBe('—')
    expect(formatAmount('-300.5')).toBe('−300.50')
  })
})

describe('formatPercent', () => {
  it('keeps the sign of a negative rate: a borrower pays the APR (review 03.10, item 3)', () => {
    expect(formatPercent('0.052')).toBe('5.20%')
    expect(formatPercent('-0.1')).toBe('−10.00%')
    expect(formatPercent('-0.000001')).toBe('0.00%')
    expect(formatPercent('-0.5', 0)).toBe('−50%')
  })
})
