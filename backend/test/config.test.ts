import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { trustProxyOption } from '../src/app.ts'
import { assertSafeBots, loadConfig, rolesInUse } from '../src/config.ts'

const SECRET = 'x'.repeat(40)
const testnet = {
  LEDGER_NETWORK: 'testnet',
  LEDGER_API_URL: 'https://ledger.testnet.example',
  AUTH_SECRET: SECRET,
  TOKEN_REGISTRY_URLS: JSON.stringify({
    usdcx: 'https://usdcx.example',
    cc: { url: 'https://validator.example/api/validator/v0/scan-proxy', auth: 'ledger' },
    cbtc: 'https://cbtc.example',
  }),
  LEDGER_OPERATOR_TOKEN: 'op-token',
  LEDGER_OPERATOR_USER_ID: 'lending-operator',
}

describe('§7: the test faucet on networks with real assets', () => {
  it('refuses TEST_FAUCET on testnet even with HOST=127.0.0.1', () => {
    expect(() => loadConfig({ ...testnet, HOST: '127.0.0.1', TEST_FAUCET: 'true' })).toThrow(
      /TEST_FAUCET.*forbidden/,
    )
  })

  it('refuses the same on mainnet', () => {
    expect(() =>
      loadConfig({ ...testnet, LEDGER_NETWORK: 'mainnet', TEST_FAUCET: 'true' }),
    ).toThrow(/mainnet/)
  })

  it('the sandbox network is gone: DevNet by default', () => {
    expect(() => loadConfig({ LEDGER_NETWORK: 'sandbox' })).toThrow()
    expect(loadConfig({}).LEDGER_NETWORK).toBe('devnet')
    expect(loadConfig({ TEST_FAUCET: 'true' }).TEST_FAUCET).toBe(true)
  })

  it('starts on testnet without dev flags', () => {
    const c = loadConfig(testnet)
    expect(c.LEDGER_NETWORK).toBe('testnet')
    expect(c.TOKEN_REGISTRY).toBe('http')
  })
})

describe('B-1: a ledger user per role on testnet', () => {
  it('needs a credential for every role the process uses', () => {
    expect(() => loadConfig({ ...testnet, BOTS: 'oracle', ORACLE_MODE: 'live' })).toThrow(
      /LEDGER_ORACLE_/,
    )
    expect(() =>
      loadConfig({
        ...testnet,
        BOTS: 'oracle',
        ORACLE_MODE: 'live',
        LEDGER_ORACLE_TOKEN: 'oracle-token',
        LEDGER_ORACLE_USER_ID: 'lending-oracle',
      }),
    ).not.toThrow()
  })
  it('refuses two roles on one ledger user', () => {
    expect(() =>
      loadConfig({
        ...testnet,
        BOTS: 'oracle',
        ORACLE_MODE: 'live',
        LEDGER_ORACLE_TOKEN: 'other',
        LEDGER_ORACLE_USER_ID: 'lending-operator',
      }),
    ).toThrow(/share one ledger user/)
  })
  it('a shared LEDGER_TOKEN does not satisfy the roles', () => {
    const rest: Record<string, string> = { ...testnet }
    delete rest.LEDGER_OPERATOR_TOKEN
    delete rest.LEDGER_OPERATOR_USER_ID
    expect(() => loadConfig({ ...rest, LEDGER_TOKEN: 'shared' })).toThrow(/LEDGER_OPERATOR_/)
  })
  it('lists roles per bot: a bot-only oracle process needs only the oracle', () => {
    expect(rolesInUse({ BOTS: ['oracle'], SERVE_API: false })).toEqual(['oracle'])
    // review 03.10, item 19: buyers read as the operator through the read-only reader
    expect(rolesInUse({ BOTS: ['liquidator', 'backstop'], SERVE_API: false }).sort()).toEqual([
      'backstop',
      'liquidator',
      'reader',
    ])
    expect(rolesInUse({ BOTS: ['absorber'], SERVE_API: false })).toEqual(['operator'])
  })
  it('maps the bot names before the Compound V3 model: monitor is absorber, settle and sweep are gone', () => {
    expect(loadConfig({ BOTS: 'oracle,monitor,settle,sweep,monitor' }).BOTS).toEqual([
      'oracle',
      'absorber',
    ])
  })
})

describe('B-2, B-17: registry and secrets', () => {
  it('requires AUTH_SECRET with ledger credentials or in production', () => {
    const rest: Record<string, string> = { ...testnet }
    delete rest.AUTH_SECRET
    expect(() => loadConfig(rest)).toThrow(/AUTH_SECRET/)
    expect(() =>
      loadConfig({
        LEDGER_API_URL: 'https://x.devnet.example',
        LEDGER_REFRESH_TOKEN_FILE: '/tmp/x',
        LEDGER_CLIENT_ID: 'c',
        LEDGER_TOKEN_URL: 'https://kc/token',
      }),
    ).toThrow(/AUTH_SECRET/)
    expect(() => loadConfig({})).not.toThrow()
  })
  it('refuses the ledger registry on testnet and needs a URL per instrument', () => {
    expect(() => loadConfig({ ...testnet, TOKEN_REGISTRY: 'ledger' })).toThrow(/ledger/)
    expect(() =>
      loadConfig({ ...testnet, TOKEN_REGISTRY_URLS: '{"usdcx":"https://u.example"}' }),
    ).toThrow(/cc, cbtc/)
  })
  it('refuses the demo oracle on testnet', () => {
    expect(() =>
      loadConfig({
        ...testnet,
        BOTS: 'oracle',
        LEDGER_ORACLE_TOKEN: 'o',
        LEDGER_ORACLE_USER_ID: 'lending-oracle',
      }),
    ).toThrow(/ORACLE_MODE=demo/)
  })
  it('the example defaults start: DevNet, live oracle without attestation', () => {
    expect(() =>
      loadConfig({ BOTS: 'oracle,accounts,monitor,logins,indexer', ORACLE_MODE: 'live' }),
    ).not.toThrow()
  })
})

describe('A-4: source maps by instrument slot', () => {
  it('maps legacy symbol keys to slots and rejects unknown ones', () => {
    const c = loadConfig({ COINGECKO_IDS: '{"CC":"canton-network","CBTC":"bitcoin"}' })
    expect(c.COINGECKO_IDS).toEqual({ cc: 'canton-network', cbtc: 'bitcoin' })
    expect(() => loadConfig({ COINGECKO_IDS: '{"Amulet":"x"}' })).toThrow(/unknown instrument/)
  })
})

describe('B-8: the live attestation bot needs a Proof of Reserve source', () => {
  it('refuses without RESERVE_ATTESTATION_URL, allows with it', () => {
    expect(() => assertSafeBots({ BOTS: ['attestation'], ORACLE_MODE: 'live' })).toThrow(
      /RESERVE_ATTESTATION_URL/,
    )
    expect(() =>
      assertSafeBots({
        BOTS: ['attestation'],
        ORACLE_MODE: 'live',
        RESERVE_ATTESTATION_URL: 'https://por.example/cbtc',
      }),
    ).not.toThrow()
  })
})

describe('B-3: client IP behind nginx', () => {
  async function ipOf(trusted: string, remoteAddress: string, xff?: string) {
    const app = Fastify({
      trustProxy: trustProxyOption({ TRUSTED_PROXIES: trusted ? trusted.split(',') : [] }),
    })
    app.get('/ip', async (req) => ({ ip: req.ip }))
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      headers: xff ? { 'x-forwarded-for': xff } : {},
    })
    await app.close()
    return res.json().ip as string
  }

  it('a spoofed left-most X-Forwarded-For does not become the client IP', async () => {
    // nginx appended the real address on the right; the client injected 6.6.6.6 on the left
    expect(await ipOf('127.0.0.1', '127.0.0.1', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9')
  })
  it('X-Forwarded-For from an untrusted address is ignored', async () => {
    expect(await ipOf('127.0.0.1', '198.51.100.7', '6.6.6.6')).toBe('198.51.100.7')
  })
  it('an empty TRUSTED_PROXIES trusts nobody', async () => {
    expect(await ipOf('', '127.0.0.1', '6.6.6.6')).toBe('127.0.0.1')
  })
})

describe('B-17: .env.example starts as is', () => {
  it('loads without errors', async () => {
    const { parseEnv } = await import('node:util')
    const { readFileSync } = await import('node:fs')
    const env = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'))
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).not.toThrow()
  })
})
