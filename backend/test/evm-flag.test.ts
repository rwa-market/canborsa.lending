/**
 * EVM_WALLETS (ADR-006: users sign in only with Loop). Off by default: no routes
 * /auth/evm/* and /evm/*, no /config.evm, no faucet for EVM addresses. With EVM_WALLETS=true
 * everything works as before. No ledger needed: we check the API surface.
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
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
  testers: [],
  usdcx: { admin: party('Usdcx'), id: 'USDCx' },
  cc: { admin: party('Cc'), id: 'CC' },
  cbtc: { admin: party('Cbtc'), id: 'CBTC' },
  // the custodian exists: only the flag turns EVM off
  evm: { custody: party('Custody') },
}
const ADDRESS = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'

async function appWith(env: Record<string, string>) {
  const path = join(tmpdir(), `deployment-evm-flag-${process.pid}.json`)
  writeFileSync(path, JSON.stringify(deployment))
  return buildApp(
    loadConfig({
      LEDGER_API_URL: 'http://127.0.0.1:9',
      DEPLOYMENT_PATH: path,
      AUTH_SECRET: TEST_SECRET,
      DATABASE_PATH: ':memory:',
      NETWORK_ID: 'canton:devnet',
      SYNCHRONIZER_ID: 'global-domain::1220',
      TEST_FAUCET: 'true',
      ...env,
    }),
  )
}

const EVM_ROUTES = [
  ['/auth/evm/challenge', { address: ADDRESS }],
  ['/auth/evm/login', { address: ADDRESS, nonce: 'n', signature: `0x${'0'.repeat(130)}` }],
  ['/evm/prepare', { address: ADDRESS, op: 'supply', amount: '1' }],
  ['/evm/submit', {}],
  ['/evm/claim-deposit', { txHash: `0x${'0'.repeat(64)}` }],
] as const

describe('EVM_WALLETS off (default)', () => {
  let app: Awaited<ReturnType<typeof appWith>>
  beforeAll(async () => {
    app = await appWith({})
  })
  afterAll(() => app.close())

  it('defaults to false', () => {
    expect(loadConfig({}).EVM_WALLETS).toBe(false)
    expect(loadConfig({ EVM_WALLETS: 'true' }).EVM_WALLETS).toBe(true)
  })

  it('registers no /auth/evm/* and /evm/* routes', async () => {
    for (const [url, payload] of EVM_ROUTES) {
      const res = await app.inject({ method: 'POST', url, payload })
      expect(res.statusCode, url).toBe(404)
    }
  })

  it('/config has no evm key, Loop stays on', async () => {
    const c = (await app.inject({ method: 'GET', url: '/config' })).json()
    expect(c).not.toHaveProperty('evm')
    expect(c.loop).toMatchObject({ enabled: true, custody: deployment.evm.custody })
  })

  it('the faucet gives nothing to an EVM address session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/faucet',
      headers: { 'x-session-token': sessionFor(ADDRESS) },
      payload: { symbol: 'USDCx' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('EVM wallets are off')
  })
})

describe('EVM_WALLETS=true', () => {
  let app: Awaited<ReturnType<typeof appWith>>
  beforeAll(async () => {
    app = await appWith({ EVM_WALLETS: 'true' })
  })
  afterAll(() => app.close())

  it('/config.evm names the network and the custody party', async () => {
    const c = (await app.inject({ method: 'GET', url: '/config' })).json()
    expect(c.evm).toEqual({ network: 'canton:devnet', custody: deployment.evm.custody })
  })

  it('serves the EVM sign-in challenge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/evm/challenge',
      payload: { address: ADDRESS },
    })
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.nonce).toMatch(/^[0-9a-f]+$/)
    expect(b.message).toContain(ADDRESS)
  })

  it('registers /evm/prepare and /evm/submit (they answer, not 404)', async () => {
    for (const url of ['/evm/prepare', '/evm/submit']) {
      const res = await app.inject({ method: 'POST', url, payload: {} })
      expect(res.statusCode, url).not.toBe(404)
    }
  })
})
