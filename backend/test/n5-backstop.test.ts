/**
 * N5: the backstop balance is read by the backstop user; /metrics has `lending_backstop_balance`,
 * /health/ready warns when it is below BACKSTOP_MIN_BALANCE (default 25000).
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { NoCredentialError } from '../src/ledger/credentials.ts'
import { createMetrics } from '../src/metrics.ts'
import { backstopBalanceSource, readiness } from '../src/routes/health.ts'
import { d, holding, roles } from './fixtures.ts'
import type { Reader } from '../src/protocol/reader.ts'

const ledger = { version: async () => '3.5.12' } as unknown as LedgerClient

async function ready(balance: string | null | Error) {
  const metrics = createMetrics()
  const r = await readiness(ledger, {
    metrics,
    backstop: {
      min: '25000',
      balance: async () => {
        if (balance instanceof Error) throw balance
        return balance
      },
    },
  })
  return { r, metrics }
}

describe('N5: backstop minimum', () => {
  it('below the minimum: a problem, the metric and the balance in the response', async () => {
    const { r, metrics } = await ready('20000')
    expect(r.ready).toBe(false)
    expect(r.problems).toContain('backstop holds 20000 USDCx, below BACKSTOP_MIN_BALANCE 25000')
    expect(r.backstopBalance).toBe('20000.0000000000')
    expect(metrics.get('lending_backstop_balance')).toBe(20000)
  })

  it('exactly at the minimum is fine, one unit below is not', async () => {
    expect((await ready('25000')).r.ready).toBe(true)
    const below = await ready('24999.9999999999')
    expect(below.r.ready).toBe(false)
  })

  it('an unreadable balance is a problem, not a silent zero', async () => {
    const { r } = await ready(null)
    expect(r.problems).toContain(
      'backstop balance is unreadable with the ledger users of this process',
    )
    expect(r.backstopBalance).toBeNull()
    const failed = await ready(new Error('HTTP 503'))
    expect(failed.r.problems.some((p) => p.startsWith('backstop balance unavailable'))).toBe(true)
  })

  it('without the backstop credential the check is absent', async () => {
    const r = await readiness(ledger, {})
    expect(r.backstopBalance).toBeNull()
    expect(r.problems.some((p) => p.includes('backstop'))).toBe(false)
  })

  it('the source reads free USDCx of the current backstop via its own route', async () => {
    const routes: string[] = []
    const reader = {
      roles: async () => roles,
      holdings: async (party: string) =>
        party === d.backstop
          ? [
              holding('b1', d.backstop, '20000', d.usdcx),
              holding('b2', d.backstop, '6000', d.usdcx),
            ]
          : [],
    } as unknown as Reader
    const route = (party: string) => {
      routes.push(party)
      if (party !== d.backstop) throw new NoCredentialError('no')
      return 'backstop'
    }
    const src = backstopBalanceSource(reader, d, route)
    expect(await src()).toBe('26000')
    expect(routes).toEqual([d.backstop])
    const rotated = backstopBalanceSource(
      { ...reader, roles: async () => ({ ...roles, backstop: 'New::1220' }) } as Reader,
      d,
      route,
    )
    expect(await rotated()).toBeNull()
  })

  it('BACKSTOP_MIN_BALANCE defaults to 25000', () => {
    expect(loadConfig({ DATABASE_PATH: ':memory:' }).BACKSTOP_MIN_BALANCE).toBe('25000')
    expect(loadConfig({ BACKSTOP_MIN_BALANCE: '1000.5' }).BACKSTOP_MIN_BALANCE).toBe('1000.5')
    expect(() => loadConfig({ BACKSTOP_MIN_BALANCE: '-1' })).toThrow()
  })
})
