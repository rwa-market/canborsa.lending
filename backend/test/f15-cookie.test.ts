/**
 * F-15: session in the httpOnly cookie `lending_session` (agreement, item 2).
 * Bearer and X-Session-Token keep working; a cookie without CSRF headers on non-GET is 403.
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { createAuth } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import type { CommandBuilder } from '../src/protocol/commands.ts'
import type { Reader } from '../src/protocol/reader.ts'
import { protocolRoutes } from '../src/routes/protocol.ts'
import { allowedOrigins, readCookie, SESSION_COOKIE } from '../src/session.ts'
import { d } from './fixtures.ts'
import { sessionFor, TEST_SECRET } from './session.ts'

const WEB = 'http://localhost:5173'
const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const h = res.headers['set-cookie']
  return (Array.isArray(h) ? h : [h]).filter(Boolean).map(String)
}
const attrs = (c: string) => c.split(';').map((x) => x.trim())

describe('F-15: session cookie', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  const alice = d.alice!
  beforeAll(async () => {
    const path = join(tmpdir(), `deployment-f15-${process.pid}.json`)
    writeFileSync(path, JSON.stringify(d))
    app = await buildApp(
      loadConfig({
        LEDGER_API_URL: 'http://127.0.0.1:9',
        DEPLOYMENT_PATH: path,
        AUTH_SECRET: TEST_SECRET,
        DATABASE_PATH: ':memory:',
        CORS_ORIGIN: WEB,
        SESSION_TTL_MS: '3600000',
      }),
    )
  })
  afterAll(() => app.close())

  /** Alice session: token with the same secret (signature sign-in: /auth/login tests below). */
  const session = () => ({ json: () => ({ token: sessionFor(alice) }) })

  it('GET with the cookie alone is authenticated; GET /auth/session restores the party', async () => {
    const token = session().json().token as string
    const cookie = `${SESSION_COOKIE}=${token}`
    const hist = await app.inject({
      method: 'GET',
      url: `/history/${encodeURIComponent(alice)}`,
      headers: { cookie },
    })
    expect(hist.statusCode).toBe(200)
    const s = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } })
    expect(s.statusCode).toBe(200)
    const body = s.json()
    expect(body.party).toBe(alice)
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 3_500_000)
    const none = await app.inject({ method: 'GET', url: '/auth/session' })
    expect(none.statusCode).toBe(401)
    const bearer = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(bearer.json().party).toBe(alice)
    const forged = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${token}x` },
    })
    expect(forged.statusCode).toBe(401)
  })

  describe('CSRF for cookie-authenticated non-GET', () => {
    let cookie = ''
    beforeAll(async () => {
      cookie = `${SESSION_COOKIE}=${session().json().token}`
    })
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/commands/withdraw',
        payload: { party: alice, amount: '1' },
        headers: { cookie, ...headers },
      })

    it('no X-Lending-Client: 403', async () => {
      const r = await post({ origin: WEB })
      expect(r.statusCode).toBe(403)
      expect(r.json().code).toBe('CSRF')
    })
    it('X-Lending-Client other than web: 403', async () => {
      expect((await post({ origin: WEB, 'x-lending-client': 'cli' })).statusCode).toBe(403)
    })
    it('no Origin: 403', async () => {
      expect((await post({ 'x-lending-client': 'web' })).statusCode).toBe(403)
    })
    it('foreign Origin: 403', async () => {
      const r = await post({ origin: 'https://evil.example', 'x-lending-client': 'web' })
      expect(r.statusCode).toBe(403)
      const lookalike = await post({ origin: `${WEB}.evil.example`, 'x-lending-client': 'web' })
      expect(lookalike.statusCode).toBe(403)
      const nullOrigin = await post({ origin: 'null', 'x-lending-client': 'web' })
      expect(nullOrigin.statusCode).toBe(403)
    })
    it('allowed Origin and the header pass the CSRF check', async () => {
      const r = await post({ origin: WEB, 'x-lending-client': 'web' })
      // next comes the command without a ledger: not a 403 CSRF
      expect(r.statusCode).not.toBe(403)
      const viaHost = await post({ origin: 'http://127.0.0.1:3001', 'x-lending-client': 'web' })
      expect(viaHost.statusCode).not.toBe(403)
    })
    it('Bearer and X-Session-Token clients need no CSRF headers', async () => {
      const token = cookie.split('=')[1]!
      const bearer = await app.inject({
        method: 'POST',
        url: '/commands/withdraw',
        payload: { party: alice, amount: '1' },
        headers: { authorization: `Bearer ${token}` },
      })
      expect(bearer.statusCode).not.toBe(403)
      const own = await app.inject({
        method: 'POST',
        url: '/commands/withdraw',
        payload: { party: alice, amount: '1' },
        headers: { 'x-session-token': token },
      })
      expect(own.statusCode).not.toBe(403)
    })
    it('a stale cookie next to a header token does not trigger CSRF', async () => {
      const token = cookie.split('=')[1]!
      const r = await app.inject({
        method: 'POST',
        url: '/commands/withdraw',
        payload: { party: alice, amount: '1' },
        headers: { cookie: `${SESSION_COOKIE}=stale`, 'x-session-token': token },
      })
      expect(r.statusCode).not.toBe(403)
    })
  })

  it('POST /auth/logout revokes the cookie session and clears the cookie', async () => {
    const token = session().json().token as string
    const cookie = `${SESSION_COOKIE}=${token}`
    const csrf = { origin: WEB, 'x-lending-client': 'web' }
    const refused = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })
    expect(refused.statusCode).toBe(403)
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, ...csrf },
    })
    expect(out.statusCode).toBe(200)
    expect(out.json()).toEqual({ revoked: true })
    const a = attrs(cookieOf(out)[0]!)
    expect(a[0]).toBe(`${SESSION_COOKIE}=`)
    expect(a).toEqual(
      expect.arrayContaining(['Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Strict']),
    )
    const after = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } })
    expect(after.statusCode).toBe(401)
  })

  it('logout without any session still clears the cookie', async () => {
    const out = await app.inject({ method: 'POST', url: '/auth/logout' })
    expect(out.json()).toEqual({ revoked: false })
    expect(attrs(cookieOf(out)[0]!)).toContain('Max-Age=0')
  })
})

describe('F-15: /auth/login sets the cookie', () => {
  it('after Login_Consume the response carries the token and the cookie', async () => {
    const auth = createAuth('x'.repeat(32), Date.now, { sessionTtlMs: 600_000 })
    const alice = d.alice!
    const nonces = [auth.challenge(alice), auth.challenge(alice)]
    const consumed: string[] = []
    const app = Fastify({ trustProxy: ['127.0.0.1'] })
    await app.register(
      protocolRoutes({
        deployment: d,
        ledger: {
          submit: async (_a: string[], cmds: { ExerciseCommand: { contractId: string } }[]) => {
            consumed.push(cmds[0]!.ExerciseCommand.contractId)
            return { updateId: 'u', events: [] }
          },
        } as unknown as LedgerClient,
        reader: {
          logins: async () =>
            nonces.map((nonce, i) => ({
              contractId: `login-${i + 1}`,
              payload: {
                user: alice,
                nonce,
                operator: d.operator,
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
            })),
        } as unknown as Reader,
        commands: {} as CommandBuilder,
        auth,
        networkId: null,
        history: () => [],
        allowedOrigins: [WEB],
      }),
    )
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { party: alice, nonce: nonces[0] },
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(res.statusCode).toBe(200)
    expect(consumed).toEqual(['login-1'])
    const token = res.json().token as string
    const a = attrs(cookieOf(res)[0]!)
    expect(a[0]).toBe(`${SESSION_COOKIE}=${token}`)
    expect(a).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=600', 'Secure']),
    )
    // https from an untrusted client does not make the cookie Secure: header not from the proxy
    const spoofed = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { party: alice, nonce: nonces[1] },
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '203.0.113.7',
    })
    expect(spoofed.statusCode).toBe(200)
    expect(attrs(cookieOf(spoofed)[0]!)).not.toContain('Secure')
    await app.close()
  })
})

describe('F-15: helpers', () => {
  it('reads one cookie among several, ignores lookalike names', () => {
    expect(readCookie('a=1; lending_session=tok.sig; b=2', SESSION_COOKIE)).toBe('tok.sig')
    expect(readCookie('xlending_session=bad', SESSION_COOKIE)).toBeUndefined()
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined()
  })
  it('the origin allowlist comes from CORS_ORIGIN and ALLOWED_HOSTS', () => {
    const o = allowedOrigins({
      CORS_ORIGIN: 'https://lending.example',
      ALLOWED_HOSTS: ['lending.example', '127.0.0.1:3001'],
    })
    expect(o).toEqual(
      expect.arrayContaining([
        'https://lending.example',
        'http://lending.example',
        'http://127.0.0.1:3001',
        'https://127.0.0.1:3001',
      ]),
    )
  })
})
