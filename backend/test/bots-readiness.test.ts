import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { absorbCommandId } from '../src/bots/absorb.ts'
import { createAccountBot } from '../src/bots/accounts.ts'
import {
  createMaintenance,
  DAML_MAX_LOGIN_TTL_MS,
  httpReserveSource,
  loginAction,
} from '../src/bots/maintenance.ts'
import { createBotRegistry, every, stopAllBots } from '../src/bots/runner.ts'
import type { Deployment } from '../src/deployment.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { byAmountDesc, ttlCache, type Reader } from '../src/protocol/reader.ts'
import type { TokenRegistry } from '../src/protocol/registry.ts'

const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger
const d = {
  operator: 'op::1',
  oracle: 'oracle::1',
  cbtc: { admin: 'b', id: 'CBTC' },
} as Deployment

describe('B-13: holdings sorted by Decimal', () => {
  it('orders fractional amounts correctly', () => {
    const hs = ['100.5', '100.25', '9.9', '10'].map((amount) => ({ view: { amount } }))
    expect(hs.sort(byAmountDesc).map((h) => h.view.amount)).toEqual([
      '100.5',
      '100.25',
      '10',
      '9.9',
    ])
  })
})

describe('B-15: absorb command id from the domain key', () => {
  it('same account version gives the same id, another version another', () => {
    expect(absorbCommandId('acc-1')).toBe(absorbCommandId('acc-1'))
    expect(absorbCommandId('acc-1')).not.toBe(absorbCommandId('acc-2'))
  })
})

describe('§2: Login TTL cap', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const at = (ms: number) => new Date(now + ms).toISOString()
  it('expires, reaps beyond the Daml cap and keeps live logins', () => {
    expect(loginAction({ expiresAt: null }, now)).toBe('expire')
    expect(loginAction({ expiresAt: at(0) }, now)).toBe('expire')
    expect(loginAction({ expiresAt: at(5 * 60_000) }, now)).toBe('keep')
    expect(loginAction({ expiresAt: at(DAML_MAX_LOGIN_TTL_MS) }, now)).toBe('keep')
    expect(loginAction({ expiresAt: at(DAML_MAX_LOGIN_TTL_MS + 61_000) }, now)).toBe('reap')
    expect(loginAction({ expiresAt: '2100-01-01T00:00:00Z' }, now)).toBe('reap')
  })

  const logins = [
    { contractId: 'old', payload: { expiresAt: new Date(Date.now() - 1000).toISOString() } },
    { contractId: 'far', payload: { expiresAt: '2100-01-01T00:00:00Z' } },
    { contractId: 'live', payload: { expiresAt: new Date(Date.now() + 60_000).toISOString() } },
  ]
  const run = async (reapFails: boolean) => {
    const choices: [string, string][] = []
    const ledger = {
      submit: async (
        _a: string[],
        cmds: { ExerciseCommand: { contractId: string; choice: string } }[],
      ) => {
        if (reapFails && cmds[0]!.ExerciseCommand.choice === 'Login_Reap')
          throw new Error('HTTP 400: unknown choice Login_Reap')
        for (const c of cmds) choices.push([c.ExerciseCommand.contractId, c.ExerciseCommand.choice])
        return { updateId: 'u', events: [] }
      },
    } as unknown as LedgerClient
    const reader = { logins: async () => logins } as unknown as Reader
    const m = createMaintenance(ledger, reader, {} as TokenRegistry, d, 'live', log)
    return { n: await m.logins(), choices, m }
  }
  it('the logins bot calls Login_Expire and Login_Reap', async () => {
    const { n, choices } = await run(false)
    expect(choices).toEqual([
      ['old', 'Login_Expire'],
      ['far', 'Login_Reap'],
    ])
    expect(n).toBe(2)
  })
  it('an old package without Login_Reap does not break the expiry', async () => {
    const { n, choices } = await run(true)
    expect(choices).toEqual([['old', 'Login_Expire']])
    expect(n).toBe(1)
  })
})

describe('B-8: Proof of Reserve source', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const src = (body: unknown) =>
    httpReserveSource(
      'https://por.example/cbtc',
      (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch,
      () => now,
    )
  it('reads coverage directly or as reserves / supply', async () => {
    expect(await src({ coverage: '1.02', attestedAt: '2026-10-01T11:00:00Z' }).fetch()).toEqual({
      coverage: '1.0200000000',
      attestedAt: '2026-10-01T11:00:00.000Z',
    })
    expect(
      (await src({ reserves: '99', supply: '100', asOf: '2026-10-01T11:00:00Z' }).fetch()).coverage,
    ).toBe('0.9900000000')
  })
  it('refuses malformed and future attestations', async () => {
    await expect(src({ coverage: 'lots' }).fetch()).rejects.toThrow(/malformed/)
    await expect(
      src({ coverage: '1', attestedAt: '2026-10-01T13:00:00Z' }).fetch(),
    ).rejects.toThrow(/future/)
  })
  it('live attestation bot publishes the source data, only when newer', async () => {
    const submitted: unknown[] = []
    const ledger = {
      query: async () => [
        {
          contractId: 'att',
          payload: {
            oracle: d.oracle,
            instrumentId: d.cbtc,
            coverage: '1',
            attestedAt: '2026-10-01T10:00:00Z',
          },
        },
      ],
      submit: async (_a: string[], cmds: { ExerciseCommand: { choiceArgument: unknown } }[]) => {
        submitted.push(cmds[0]!.ExerciseCommand.choiceArgument)
        return { updateId: 'u', events: [] }
      },
    } as unknown as LedgerClient
    const fresh = {
      name: 'por',
      fetch: async () => ({ coverage: '0.98', attestedAt: '2026-10-01T11:00:00.000Z' }),
    }
    const m = createMaintenance(ledger, {} as Reader, {} as TokenRegistry, d, 'live', log, fresh)
    expect(await m.attestation()).toBe(1)
    expect(submitted).toEqual([{ newCoverage: '0.98', newAttestedAt: '2026-10-01T11:00:00.000Z' }])
    const stale = {
      name: 'por',
      fetch: async () => ({ coverage: '1', attestedAt: '2026-10-01T09:00:00.000Z' }),
    }
    expect(
      await createMaintenance(
        ledger,
        {} as Reader,
        {} as TokenRegistry,
        d,
        'live',
        log,
        stale,
      ).attestation(),
    ).toBe(0)
    // live without a source re-signs nothing (M3)
    expect(
      await createMaintenance(
        ledger,
        {} as Reader,
        {} as TokenRegistry,
        d,
        'live',
        log,
      ).attestation(),
    ).toBe(0)
  })
})

describe('B-16: daily account opening cap', () => {
  it('stops opening at the cap and resumes after 24 hours', async () => {
    let t = 0
    const requests = Array.from({ length: 30 }, (_, i) => ({
      contractId: `r${i}`,
      payload: { operator: d.operator, user: `u${i}::1` },
    }))
    const opened: string[] = []
    const reader = {
      accountRequests: async () => requests.filter((r) => !opened.includes(r.contractId)),
      accounts: async () => [],
      directory: async () => ({ contractId: 'dir' }),
    } as unknown as Reader
    const ledger = {
      submit: async (
        _a: string[],
        cmds: { ExerciseCommand: { choiceArgument: { requestCid: string } } }[],
      ) => {
        opened.push(cmds[0]!.ExerciseCommand.choiceArgument.requestCid)
        return { updateId: 'u', events: [] }
      },
    } as unknown as LedgerClient
    const bot = createAccountBot(ledger, reader, d, log, { opensPerDay: 12, now: () => t })
    await bot()
    await bot()
    await bot()
    expect(opened).toHaveLength(12)
    t += 86_400_001
    await bot()
    expect(opened).toHaveLength(22)
  })
})

describe('B-10, B-14: bot status and graceful stop', () => {
  it('counts consecutive failures and marks the bot as error at the threshold', async () => {
    const reg = createBotRegistry(2)
    let fail = true
    const h = every(
      'oracle',
      5,
      async () => {
        if (fail) throw new Error('boom')
      },
      log,
      'test-lock-a',
      reg,
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(reg.list()[0]).toMatchObject({ name: 'oracle', state: 'error', lastError: 'boom' })
    fail = false
    await new Promise((r) => setTimeout(r, 30))
    expect(reg.list()[0]).toMatchObject({ state: 'ok', consecutiveFailures: 0 })
    await h.stop()
    expect(reg.list()[0]!.state).toBe('stopped')
  })

  it('stop waits for the running step before the lease is released', async () => {
    const events: string[] = []
    let release!: () => void
    const h = every(
      'settle',
      1_000,
      async () => {
        events.push('step started')
        await new Promise<void>((r) => (release = r))
        events.push('step finished')
      },
      log,
      'test-lock-b',
    )
    await new Promise((r) => setTimeout(r, 5))
    const stopping = stopAllBots([h], 1_000).then((ok) => events.push(`stopped ${ok}`))
    setTimeout(() => release(), 20)
    await stopping
    events.push('lease released')
    expect(events).toEqual(['step started', 'step finished', 'stopped true', 'lease released'])
  })

  it('gives up waiting after the timeout', async () => {
    const h = every('stuck', 1_000, () => new Promise(() => {}), log, 'test-lock-c')
    await new Promise((r) => setTimeout(r, 5))
    expect(await stopAllBots([h], 20)).toBe(false)
  })
})

describe('B-4: read cache', () => {
  it('shares one load between concurrent readers and expires after the TTL', async () => {
    let t = 0
    let loads = 0
    const c = ttlCache(
      1_500,
      async () => ++loads,
      () => t,
    )
    expect(await Promise.all([c.get(), c.get(), c.get()])).toEqual([1, 1, 1])
    t += 1_499
    expect(await c.get()).toBe(1)
    t += 1
    expect(await c.get()).toBe(2)
  })
  it('reloads as soon as the ledger version moves: a write is visible before the TTL', async () => {
    let loads = 0
    const c = ttlCache(10_000, async () => ++loads)
    expect(await c.get(5)).toBe(1)
    expect(await c.get(5)).toBe(1)
    // the transaction moved ledger-end: the loan is visible on the next read
    expect(await c.get(6)).toBe(2)
    expect(await c.get(6)).toBe(2)
  })
  it('does not cache errors', async () => {
    let n = 0
    const c = ttlCache(10_000, async () => {
      if (n++ === 0) throw new Error('down')
      return 'ok'
    })
    await expect(c.get()).rejects.toThrow('down')
    expect(await c.get()).toBe('ok')
  })
})
