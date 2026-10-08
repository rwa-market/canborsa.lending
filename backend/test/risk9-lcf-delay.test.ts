// Risk 9: a lower liquidateCollateralFactor executes 2 days after the proposal (Governance.daml)
import { describe, expect, it } from 'vitest'
import {
  applyParamsPatch,
  executableAfter,
  LIQUIDATION_FACTOR_DELAY_MS,
  lowersLiquidationFactor,
} from '../src/protocol/governance.ts'
import type { MarketParams } from '../src/protocol/types.ts'

const cbtc = {
  liquidateCollateralFactor: '0.65',
  borrowCollateralFactor: '0.5',
  liquidationFactor: '0.95',
} as MarketParams
const config = { marketParams: [['CBTC', cbtc]] as [string, MarketParams][] }
const withLcf = (lcf: string, bcf = '0.5'): [string, MarketParams][] => [
  ['CBTC', { ...cbtc, liquidateCollateralFactor: lcf, borrowCollateralFactor: bcf }],
]

describe('risk 9: liquidation factor delay', () => {
  it('only a lower liquidateCollateralFactor waits', () => {
    expect(lowersLiquidationFactor(config.marketParams, withLcf('0.6499'))).toBe(true)
    expect(lowersLiquidationFactor(config.marketParams, withLcf('0.65'))).toBe(false)
    expect(lowersLiquidationFactor(config.marketParams, withLcf('0.7'))).toBe(false)
    expect(lowersLiquidationFactor(config.marketParams, withLcf('0.65', '0.3'))).toBe(false)
    expect(lowersLiquidationFactor(config.marketParams, [])).toBe(false)
    // 1.0.2: a bigger absorb penalty (lower liquidationFactor) waits too; a smaller one does not
    const lf = (v: string): [string, MarketParams][] => [
      ['CBTC', { ...cbtc, liquidationFactor: v }],
    ]
    expect(lowersLiquidationFactor(config.marketParams, lf('0.9499'))).toBe(true)
    expect(lowersLiquidationFactor(config.marketParams, lf('0.96'))).toBe(false)
  })

  it('executableAfter is proposedAt + 2 days', () => {
    const proposedAt = '2026-10-01T12:00:00.000Z'
    expect(LIQUIDATION_FACTOR_DELAY_MS).toBe(172_800_000)
    expect(executableAfter({ proposedAt, newMarketParams: withLcf('0.6') }, config)).toBe(
      '2026-10-03T12:00:00.000Z',
    )
    expect(executableAfter({ proposedAt, newMarketParams: withLcf('0.7') }, config)).toBeNull()
  })
})

describe('review 03.10, item 16: the council proposes rate model changes', () => {
  const params = {
    minLoan: '250',
    rateModel: { baseRate: '0.02', slope1: '0.08', maxUtilization: '0.8' },
  } as unknown as Parameters<typeof applyParamsPatch>[0]

  it('patches top-level fields and rateModel.<field>, leaves the rest as it is', () => {
    const next = applyParamsPatch(params, { minLoan: '100', 'rateModel.maxUtilization': '0.9' })
    expect(next).toMatchObject({
      minLoan: '100',
      rateModel: { baseRate: '0.02', slope1: '0.08', maxUtilization: '0.9' },
    })
    expect(
      (params as unknown as { rateModel: { maxUtilization: string } }).rateModel.maxUtilization,
    ).toBe('0.8')
  })

  it('refuses unknown or too deep names', () => {
    for (const k of ['nope', 'rateModel.nope', 'limits.minLoan', 'rateModel.slope1.x'])
      expect(() => applyParamsPatch(params, { [k]: '1' })).toThrow(/Unknown protocol parameter/)
  })
})
