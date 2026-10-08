import { describe, expect, it } from 'vitest'
import { formatAge, priceIssue } from '@lending/shared'

const view = { instrument: 'CC', collateralPrice: '1', debtPrice: '1', liquidationValid: false }

describe('price problems in words (review 08.10, item 1)', () => {
  it('ages: seconds below 2 minutes, then minutes, then hours', () => {
    expect(formatAge(119)).toBe('119 s')
    expect(formatAge(120)).toBe('2 min')
    expect(formatAge(7199)).toBe('119 min')
    expect(formatAge(7200)).toBe('2 h')
  })
  it('a valid price has no issue; a stale one names the reason and the age', () => {
    expect(priceIssue({ ...view, ageSeconds: 10, valid: true, reason: null })).toBeNull()
    expect(priceIssue({ ...view, ageSeconds: 363, valid: false, reason: 'stale price' })).toBe(
      'stale price, oldest quote 6 min old',
    )
    expect(priceIssue(null)).toBe('no price published yet')
  })
})
