/**
 * Risk 6: supplyCap is in asset units; /health/ready warns when users' collateral of a market is
 * worth more than COLLATERAL_ALERT_USD (default 75000). Fixture: 10 000 CC at $0.2 = $2 000.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { createMetrics } from '../src/metrics.ts'
import { readiness } from '../src/routes/health.ts'
import { d, readerWith, snapshot } from './fixtures.ts'

const ledger = { version: async () => '3.5.12' } as unknown as LedgerClient
const collateralProblems = async (collateralAlertUsd: string) => {
  const metrics = createMetrics()
  const r = await readiness(ledger, {
    deployment: d,
    reader: readerWith(snapshot(), null),
    collateralAlertUsd,
    metrics,
  })
  return { problems: r.problems.filter((p) => p.includes('COLLATERAL_ALERT_USD')), metrics }
}

describe('risk 6: dollar value of the collateral', () => {
  it('exactly at the threshold is fine, a cent below it is a problem', async () => {
    expect((await collateralProblems('2000')).problems).toEqual([])
    const { problems, metrics } = await collateralProblems('1999.99')
    expect(problems).toEqual([
      'CC collateral is worth $2000, above COLLATERAL_ALERT_USD 1999.99: the council reviews supplyCap',
    ])
    expect(metrics.get('lending_collateral_usd', { market: 'CC' })).toBe(2000)
  })

  it('defaults to $75 000', () => {
    expect(loadConfig({}).COLLATERAL_ALERT_USD).toBe('75000')
  })
})
