import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientCredentialsToken, refreshingToken, staticToken } from '../src/ledger/token.ts'

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

function tokenFile(refresh: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'tok-')), 'tokens.json')
  writeFileSync(file, JSON.stringify({ refresh_token: refresh }))
  return file
}

describe('ledger token', () => {
  it('refreshes before expiry and keeps a rotated refresh token', async () => {
    let t = 1_000_000
    const calls: string[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as URLSearchParams)
      calls.push(body.get('refresh_token')!)
      return new Response(
        JSON.stringify({
          access_token: jwt({ sub: 'team-user', exp: t / 1000 + 180 }),
          refresh_token: `r${calls.length + 1}`,
        }),
      )
    }) as typeof fetch
    const file = tokenFile('r1')
    const src = await refreshingToken({
      tokenUrl: 'https://kc/token',
      clientId: 'c',
      file,
      fetchImpl,
      now: () => t,
    })
    expect(src.subject()).toBe('team-user')
    await src.header()
    expect(calls).toEqual(['r1'])
    t += 125_000 // a minute before expiry: a new token
    await src.header()
    expect(calls).toEqual(['r1', 'r2'])
    expect(JSON.parse(readFileSync(file, 'utf8')).refresh_token).toBe('r3')
  })

  it('fails with a hint when the provider refuses', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch
    await expect(
      refreshingToken({
        tokenUrl: 'https://kc/token',
        clientId: 'c',
        file: tokenFile('x'),
        fetchImpl,
      }),
    ).rejects.toThrow(/devnet-login/)
  })

  it('accepts opaque static tokens', () => {
    expect(staticToken('opaque').subject()).toBeNull()
  })
})

describe('B-9: token refresh without storms', () => {
  it('backs off after a refusal instead of calling the provider on every request', async () => {
    let t = 1_000_000
    let calls = 0
    let fail = false
    const fetchImpl = (async () => {
      calls++
      if (fail) return new Response('{"error":"invalid_grant"}', { status: 400 })
      return new Response(JSON.stringify({ access_token: jwt({ sub: 'u', exp: t / 1000 + 120 }) }))
    }) as unknown as typeof fetch
    const src = await refreshingToken({
      tokenUrl: 'https://kc/token',
      clientId: 'c',
      file: tokenFile('r1'),
      fetchImpl,
      now: () => t,
    })
    fail = true
    t += 70_000 // less than a minute to expiry: a refresh is needed
    await expect(src.header()).rejects.toThrow(/HTTP 400/)
    expect(src.status()).toMatchObject({ ok: false })
    const before = calls
    // during the pause requests do not go to the provider; a live token is still served
    for (let i = 0; i < 20; i++) await src.header()
    expect(calls).toBe(before)
    t += 60_000 // the token has expired, and so has the pause
    fail = false
    await src.header()
    expect(calls).toBe(before + 1)
    expect(src.status().ok).toBe(true)
  })

  it('a 401 forces a refresh at most once per interval', async () => {
    const t = 1_000_000
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ access_token: jwt({ sub: 'u', exp: t / 1000 + 3600 }) }))
    }) as unknown as typeof fetch
    const src = await refreshingToken({
      tokenUrl: 'https://kc/token',
      clientId: 'c',
      file: tokenFile('r1'),
      fetchImpl,
      now: () => t,
    })
    expect(calls).toBe(1)
    await src.header(true)
    await src.header(true)
    await src.header(true)
    expect(calls).toBe(2)
  })

  it('re-reads the refresh token rotated by the other blue/green slot', async () => {
    let t = 1_000_000
    const sent: string[] = []
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent.push(new URLSearchParams(init.body as URLSearchParams).get('refresh_token')!)
      return new Response(JSON.stringify({ access_token: jwt({ sub: 'u', exp: t / 1000 + 120 }) }))
    }) as unknown as typeof fetch
    const file = tokenFile('r1')
    const src = await refreshingToken({
      tokenUrl: 'https://kc/token',
      clientId: 'c',
      file,
      fetchImpl,
      now: () => t,
    })
    writeFileSync(file, JSON.stringify({ refresh_token: 'rotated-by-slot-b' }))
    t += 70_000
    await src.header()
    expect(sent).toEqual(['r1', 'rotated-by-slot-b'])
  })

  it('client credentials: a service client without a person', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-'))
    const secretFile = join(dir, 'secret')
    writeFileSync(secretFile, 's3cr3t\n')
    const forms: URLSearchParams[] = []
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      forms.push(new URLSearchParams(init.body as URLSearchParams))
      return new Response(JSON.stringify({ access_token: 'opaque', expires_in: 300 }))
    }) as unknown as typeof fetch
    const src = await clientCredentialsToken({
      tokenUrl: 'https://kc/token',
      clientId: 'lending-oracle',
      secretFile,
      audience: 'https://canton.network.global',
      fetchImpl,
    })
    expect(await src.header()).toBe('Bearer opaque')
    expect(Object.fromEntries(forms[0]!)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'lending-oracle',
      client_secret: 's3cr3t',
      audience: 'https://canton.network.global',
    })
  })
})
