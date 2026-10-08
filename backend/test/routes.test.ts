import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { publicMessage } from '../src/ledger/client.ts'
import { sessionFor, TEST_SECRET } from './session.ts'

const party = (n: string) => `${n}::1220abcdef0123456789`
const deployment = {
  operator: party('Operator'),
  oracle: party('Oracle'),
  guardian: party('Guardian'),
  treasury: party('Treasury'),
  backstop: party('Backstop'),
  liquidator: party('Liquidator'),
  alice: party('Alice'),
  bob: party('Bob'),
  testers: [party('Tester1'), party('Tester2')],
  usdcx: { admin: party('Usdcx'), id: 'USDCx' },
  cc: { admin: party('Cc'), id: 'CC' },
  cbtc: { admin: party('Cbtc'), id: 'CBTC' },
}

describe('protocol routes without ledger', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let aliceToken = ''

  beforeAll(async () => {
    const path = join(tmpdir(), `deployment-${process.pid}.json`)
    writeFileSync(path, JSON.stringify(deployment))
    app = await buildApp(
      loadConfig({
        LEDGER_API_URL: 'http://127.0.0.1:9',
        DEPLOYMENT_PATH: path,
        AUTH_SECRET: TEST_SECRET,
        DATABASE_PATH: ':memory:',
      }),
    )
    aliceToken = sessionFor(deployment.alice)
  })

  afterAll(() => app.close())

  const auth = (t: string) => ({ authorization: `Bearer ${t}` })

  it('exposes instruments and deployed markets; no dev routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/config' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ markets: ['CC', 'CBTC'], network: { name: 'devnet' } })
    expect(res.json()).not.toHaveProperty('devWallet')
    for (const url of ['/dev/session', '/dev/submit', '/dev/faucet', '/dev/prices']) {
      const r = await app.inject({ method: 'POST', url, payload: { party: deployment.alice } })
      expect(r.statusCode).toBe(404)
    }
  })

  it('liquidator and treasury screens are closed to other parties', async () => {
    const liq = await app.inject({
      method: 'GET',
      url: `/buyer/${encodeURIComponent(deployment.alice)}`,
      headers: auth(aliceToken),
    })
    expect(liq.statusCode).toBe(403)
    const other = await app.inject({
      method: 'GET',
      url: `/buyer/${encodeURIComponent(deployment.liquidator)}`,
      headers: auth(aliceToken),
    })
    expect(other.statusCode).toBe(403)
    const treasury = await app.inject({
      method: 'GET',
      url: '/treasury',
      headers: auth(aliceToken),
    })
    expect(treasury.statusCode).toBe(403)
    const fund = await app.inject({
      method: 'POST',
      url: '/treasury/add-reserves',
      headers: auth(aliceToken),
      payload: { amount: '100' },
    })
    expect(fund.statusCode).toBe(403)
  })

  it('routes a node-wallet party id longer than 100 characters', async () => {
    // Node user party: UUID hint + fingerprint, 106 characters
    const longParty = `9704abd8-8e61-4332-95e9-857ae81e51c9::1220${'a'.repeat(64)}`
    const res = await app.inject({
      method: 'GET',
      url: `/accounts/${encodeURIComponent(longParty)}`,
    })
    // without a session: 401 from the route, not 414 from the router
    expect(res.statusCode).toBe(401)
  })

  it('requires a session for party data', async () => {
    const res = await app.inject({ method: 'GET', url: `/accounts/${deployment.bob}` })
    expect(res.statusCode).toBe(401)
  })

  it("refuses another party's data with a valid session", async () => {
    for (const url of [`/accounts/${deployment.bob}`, `/history/${deployment.bob}`]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(aliceToken) })
      expect(res.statusCode).toBe(403)
    }
    const cmd = await app.inject({
      method: 'POST',
      url: '/commands/borrow',
      headers: auth(aliceToken),
      payload: { party: deployment.bob, marketId: 'CC', amount: '300' },
    })
    expect(cmd.statusCode).toBe(403)
  })

  it('reads the session from X-Session-Token, leaving Authorization to basic auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/accounts/${deployment.bob}`,
      headers: { 'x-session-token': aliceToken, authorization: 'Basic ZGVtbzpwYXNz' },
    })
    // Alice's session is read from its header: another account gives 403, not 401
    expect(res.statusCode).toBe(403)
  })

  it('refuses a forged token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/accounts/${deployment.alice}`,
      headers: auth(`${aliceToken}x`),
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects numbers as amounts: money travels as strings', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/commands/supply',
      headers: auth(aliceToken),
      payload: { party: deployment.alice, amount: 100 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects more than 10 decimal places and unknown markets', async () => {
    const tooPrecise = await app.inject({
      method: 'POST',
      url: '/commands/borrow',
      headers: auth(aliceToken),
      payload: { party: deployment.alice, amount: '1.00000000001' },
    })
    expect(tooPrecise.statusCode).toBe(400)
    const market = await app.inject({
      method: 'POST',
      url: '/commands/deposit-collateral',
      headers: auth(aliceToken),
      payload: { party: deployment.alice, marketId: 'ETH', amount: '1' },
    })
    expect(market.statusCode).toBe(400)
  })

  it('treats prototype names as unknown commands', async () => {
    for (const op of ['toString', 'constructor', 'drain']) {
      const res = await app.inject({ method: 'POST', url: `/commands/${op}`, payload: {} })
      expect(res.statusCode).toBe(404)
    }
  })

  it('login refuses a nonce this server did not issue, before touching the ledger (M1)', async () => {
    const legacy = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { party: deployment.alice, nonce: 'a'.repeat(32) },
    })
    expect(legacy.statusCode).toBe(400)
    const forged = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { party: deployment.alice, nonce: 'a'.repeat(60) },
    })
    expect(forged.statusCode).toBe(401)
  })

  it('pause needs a guardian session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/pause',
      headers: auth(aliceToken),
      payload: { flag: 'borrowPaused', paused: true },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('ledger error sanitising', () => {
  it('marks inactive contracts as stale', () => {
    expect(publicMessage('Rejected transaction is referring to inactive contracts [00ab]')).toMatch(
      /^STALE_CONTRACT:/,
    )
  })

  it('marks pool contention as retryable', () => {
    expect(publicMessage('Rejected transaction is referring to locked contracts [00ab…]')).toMatch(
      /^BUSY:/,
    )
  })

  it('keeps the contract abort text and hides internals', () => {
    expect(
      publicMessage(
        'Interpretation error: Failed with status: UNHANDLED_EXCEPTION/DA.Exception.GeneralError:GeneralError: loan exceeds LTV Using Canton Error Category',
      ),
    ).toBe('loan exceeds LTV')
    expect(
      publicMessage(
        'HTTP 400: Interpretation error: Error: User failure: UNHANDLED_EXCEPTION/DA.Exception.GeneralError:GeneralError (error category 9): max debt per user exceeded',
      ),
    ).toBe('max debt per user exceeded')
    expect(publicMessage('CONTRACT_NOT_FOUND(11,abc): Contract could not be found')).toMatch(
      /^STALE_CONTRACT/,
    )
    expect(publicMessage('non expected character 0x24 in Daml-LF Party')).toBe(
      'The ledger rejected the command',
    )
  })
})
