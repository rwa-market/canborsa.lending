/**
 * К6: /health/ready reports net reserves below RESERVES_ALERT_USD (default 0: only a negative value,
 * when the contract closes loans and deposit withdrawals). Fixture: cash 50 000 + debt 50 000 −
 * deposits 100 000 = 0 reserves, no absorbed stock.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { createMetrics } from '../src/metrics.ts'
import { readiness } from '../src/routes/health.ts'
import { d, readerWith, snapshot } from './fixtures.ts'

const ledger = { version: async () => '3.5.12' } as unknown as LedgerClient
const reservesProblems = async (reservesAlertUsd: string | undefined, cash = '50000') => {
  const metrics = createMetrics()
  const s = snapshot()
  s.pool.payload.state.cash = cash
  const r = await readiness(ledger, {
    deployment: d,
    reader: readerWith(s, null),
    ...(reservesAlertUsd === undefined ? {} : { reservesAlertUsd }),
    metrics,
  })
  return { problems: r.problems.filter((p) => p.startsWith('net reserves')), metrics }
}

describe('К6: net reserves in readiness', () => {
  it('zero reserves at the default threshold are fine', async () => {
    const { problems, metrics } = await reservesProblems('0')
    expect(problems).toEqual([])
    expect(metrics.get('lending_net_reserves')).toBe(0)
  })

  it('negative net reserves: loans and deposit withdrawals are closed', async () => {
    expect((await reservesProblems('0', '49000')).problems).toEqual([
      'net reserves are -1000.00 USDCx: new loans and deposit withdrawals are closed until treasury adds reserves',
    ])
  })

  it('starting reserves not added yet on a new ledger', async () => {
    expect((await reservesProblems('15000', '64999.99')).problems).toEqual([
      'net reserves are 14999.99 USDCx, below RESERVES_ALERT_USD 15000: treasury adds reserves',
    ])
    expect((await reservesProblems('15000', '65000')).problems).toEqual([])
  })

  it('no threshold given: no check', async () => {
    expect((await reservesProblems(undefined, '0')).problems).toEqual([])
  })

  it('defaults to 0', () => {
    expect(loadConfig({}).RESERVES_ALERT_USD).toBe('0')
  })
})
