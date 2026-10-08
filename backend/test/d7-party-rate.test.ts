/**
 * D-7, mitigation: per-party command preparation limit (COMMAND_RATE_PER_PARTY_PER_MINUTE).
 * A stream of small operations from one party must not hold the Pool from everyone else.
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { createPartyRateLimiter } from '../src/routes/protocol.ts'
import { d, p } from './fixtures.ts'
import { sessionFor, TEST_SECRET } from './session.ts'

describe('D-7: per-party limiter', () => {
  it('allows exactly the limit per minute, refuses one more, per party', () => {
    const t = { now: 0 }
    const limit = createPartyRateLimiter(3, () => t.now)
    expect([limit.take('a'), limit.take('a'), limit.take('a')]).toEqual([0, 0, 0])
    // the fourth is refused; the response gives seconds until the window frees up
    expect(limit.take('a')).toBe(60)
    expect(limit.take('b')).toBe(0)
    t.now = 59_999
    expect(limit.take('a')).toBeGreaterThan(0)
    t.now = 60_000
    expect(limit.take('a')).toBe(0)
  })

  it('memory stays bounded: idle parties are dropped', () => {
    const t = { now: 0 }
    const limit = createPartyRateLimiter(1, () => t.now)
    for (let i = 0; i < 100; i++) limit.take(`p${i}`)
    t.now = 120_000
    limit.take('x')
    expect(limit.size()).toBe(1)
  })
})

describe('D-7: command routes answer 429 with a code over the limit', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  const token: Record<string, string> = {}
  beforeAll(async () => {
    const path = join(tmpdir(), `deployment-d7-${process.pid}.json`)
    writeFileSync(path, JSON.stringify({ ...d, bob: p('Bob') }))
    app = await buildApp(
      loadConfig({
        LEDGER_API_URL: 'http://127.0.0.1:9',
        DEPLOYMENT_PATH: path,
        AUTH_SECRET: TEST_SECRET,
        DATABASE_PATH: ':memory:',
        COMMAND_RATE_PER_PARTY_PER_MINUTE: '2',
      }),
    )
    for (const who of [d.alice!, p('Bob')]) token[who] = sessionFor(who)
  })
  afterAll(() => app.close())

  const withdraw = (who: string) =>
    app.inject({
      method: 'POST',
      url: '/commands/withdraw',
      payload: { party: who, amount: '1' },
      headers: { 'x-session-token': token[who]! },
    })

  it('the third prepare in a minute is 429 PARTY_RATE_LIMITED; another party is not affected', async () => {
    expect((await withdraw(d.alice!)).statusCode).not.toBe(429)
    expect((await withdraw(d.alice!)).statusCode).not.toBe(429)
    const third = await withdraw(d.alice!)
    expect(third.statusCode).toBe(429)
    expect(third.json().code).toBe('PARTY_RATE_LIMITED')
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0)
    expect((await withdraw(p('Bob'))).statusCode).not.toBe(429)
  })

  it('a request without a session is 401 and does not spend the limit', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/commands/withdraw',
      payload: { party: p('Bob'), amount: '1' },
    })
    expect(r.statusCode).toBe(401)
    expect((await withdraw(p('Bob'))).statusCode).not.toBe(429)
  })

  it('preview is a read and is not limited per party', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/preview',
        payload: { party: d.alice, op: 'withdraw', amount: '1' },
        headers: { 'x-session-token': token[d.alice!]! },
      })
      expect(r.statusCode).not.toBe(429)
    }
  })

  it('COMMAND_RATE_PER_PARTY_PER_MINUTE defaults to 20', () => {
    expect(loadConfig({}).COMMAND_RATE_PER_PARTY_PER_MINUTE).toBe(20)
    expect(() => loadConfig({ COMMAND_RATE_PER_PARTY_PER_MINUTE: '0' })).toThrow()
  })
})
