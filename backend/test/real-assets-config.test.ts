/**
 * Seam 2: real-asset flags are fail-closed, network profiles, DevNet unchanged.
 */
import { describe, expect, it } from 'vitest'
import {
  assertDeploymentMatchesProfile,
  floorDecimal,
  fromUnits,
  REAL_PROFILES,
  toUnits,
} from '../src/assets/profiles.ts'
import { buildPriceSources } from '../src/bots/prices.ts'
import { loadConfig, rolesInUse } from '../src/config.ts'
import { d } from './fixtures.ts'

const SECRET = 'x'.repeat(40)
const testnet = {
  LEDGER_NETWORK: 'testnet',
  LEDGER_API_URL: 'https://ledger.testnet.example',
  AUTH_SECRET: SECRET,
  LEDGER_OPERATOR_TOKEN: 'op-token',
  LEDGER_OPERATOR_USER_ID: 'lending-operator',
}
const real = {
  ...testnet,
  REAL_ASSETS: 'true',
  ASSET_PROFILE: 'real',
  EVM_WALLETS: 'true',
  LEDGER_CUSTODY_TOKEN: 'custody-token',
  LEDGER_CUSTODY_USER_ID: 'lending-custody',
}

describe('real assets flags fail closed', () => {
  it('DevNet by default: profile test, no real profile, registries untouched', () => {
    const c = loadConfig({})
    expect(c.REAL_ASSETS).toBe(false)
    expect(c.ASSET_PROFILE).toBe('test')
    expect(c.realProfile).toBeNull()
    expect(c.TOKEN_REGISTRY).toBe('ledger')
    expect(c.TOKEN_REGISTRY_URLS).toEqual({})
    expect(rolesInUse(c)).toEqual(['operator'])
  })

  it('refuses profile real on DevNet even with REAL_ASSETS=true', () => {
    expect(() => loadConfig({ REAL_ASSETS: 'true', ASSET_PROFILE: 'real' })).toThrow(
      /only for LEDGER_NETWORK=testnet or mainnet/,
    )
  })

  it('refuses profile real without REAL_ASSETS, and REAL_ASSETS without profile real', () => {
    expect(() => loadConfig({ ...real, REAL_ASSETS: 'false' })).toThrow(/needs REAL_ASSETS=true/)
    expect(() => loadConfig({ ...testnet, REAL_ASSETS: 'true' })).toThrow(
      /needs ASSET_PROFILE=real/,
    )
    expect(() => loadConfig({ ASSET_PROFILE: 'demo' })).toThrow()
  })

  it('refuses REAL_ASSETS without EVM_WALLETS: withdrawals and deposits go through /evm/*', () => {
    const rest: Record<string, string> = { ...real }
    delete rest.EVM_WALLETS
    expect(() => loadConfig(rest)).toThrow(/needs EVM_WALLETS=true/)
    expect(() => loadConfig({ ...real, EVM_WALLETS: 'false' })).toThrow(/needs EVM_WALLETS=true/)
  })

  it('refuses deposits and redeems bots without profile real', () => {
    expect(() => loadConfig({ BOTS: 'deposits' })).toThrow(/needs ASSET_PROFILE=real/)
    expect(() => loadConfig({ ...testnet, BOTS: 'redeems' })).toThrow(/needs ASSET_PROFILE=real/)
  })

  it('testnet real: network instruments and registries, custody credential required', () => {
    const c = loadConfig(real)
    expect(c.realProfile?.network).toBe('testnet')
    expect(c.realProfile?.instruments.cc).toEqual({
      admin: 'DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337',
      id: 'Amulet',
    })
    expect(c.TOKEN_REGISTRY_URLS.usdcx).toBe(
      'https://api.utilities.digitalasset-staging.com/api/token-standard/v0/registrars/decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61',
    )
    const rest: Record<string, string> = { ...real }
    delete rest.LEDGER_CUSTODY_TOKEN
    delete rest.LEDGER_CUSTODY_USER_ID
    expect(() => loadConfig(rest)).toThrow(/LEDGER_CUSTODY_/)
  })

  it('an explicit registry URL (scan-proxy) wins over the profile default', () => {
    const c = loadConfig({
      ...real,
      TOKEN_REGISTRY_URLS: JSON.stringify({
        cc: { url: 'https://validator.example/api/validator/v0/scan-proxy', auth: 'ledger' },
      }),
    })
    expect(c.TOKEN_REGISTRY_URLS.cc).toEqual({
      url: 'https://validator.example/api/validator/v0/scan-proxy',
      auth: 'ledger',
    })
    expect(c.TOKEN_REGISTRY_URLS.cbtc).toBe(REAL_PROFILES.testnet.registries.cbtc)
  })

  it('mainnet real uses mainnet parties and Ethereum mainnet xReserve', () => {
    const c = loadConfig({ ...real, LEDGER_NETWORK: 'mainnet' })
    expect(c.realProfile?.instruments.usdcx.admin).toMatch(
      /^decentralized-usdc-interchain-rep::12208115/,
    )
    expect(c.realProfile?.xreserve).toEqual({
      chainId: 1,
      contract: '0x8888888199b2df864bf678259607d6d5ebb4e3ce',
      usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      cantonDomain: 10001,
    })
  })

  it('deposits and redeems bots need the custody and operator users', () => {
    expect(rolesInUse({ BOTS: ['deposits'], SERVE_API: false }).sort()).toEqual([
      'custody',
      'operator',
    ])
    expect(() => loadConfig({ ...real, BOTS: 'deposits,redeems' })).not.toThrow()
  })
})

describe('keyed price sources', () => {
  it('a keyed source named in ORACLE_SOURCES without its key refuses to start', () => {
    expect(() => loadConfig({ ORACLE_SOURCES: 'coingecko,redstone' })).toThrow(/redstone.*API key/)
    expect(() => loadConfig({ ORACLE_SOURCES: 'coingecko,kaiko' })).toThrow(/kaiko/)
    expect(() =>
      loadConfig({ ORACLE_SOURCES: 'coingecko,chainlink', CHAINLINK_STREAMS_API_KEY: 'k' }),
    ).toThrow(/chainlink/)
  })

  it('with keys the sources are built; without being named they stay off', () => {
    const c = loadConfig({
      ORACLE_SOURCES: 'coingecko,redstone,kaiko',
      REDSTONE_API_KEY: 'r',
      KAIKO_API_KEY: 'k',
    })
    expect(buildPriceSources(c).map((s) => s.name)).toEqual(['coingecko', 'redstone', 'kaiko'])
    const off = loadConfig({ REDSTONE_API_KEY: 'r' })
    expect(buildPriceSources(off).map((s) => s.name)).toEqual([
      'coingecko',
      'kucoin',
      'binance',
      'bybit',
    ])
  })
})

describe('real profile deployment check', () => {
  const t = REAL_PROFILES.testnet
  const good = { ...d, ...t.instruments, evm: { custody: 'Custody::1220aa' } }
  it('accepts the network instruments with an EVM custody party', () => {
    expect(() => assertDeploymentMatchesProfile(good, t)).not.toThrow()
  })
  it('refuses test tokens, ETH/SOL markets and a missing custody party', () => {
    expect(() => assertDeploymentMatchesProfile({ ...good, cc: d.cc }, t)).toThrow(/deployment cc/)
    expect(() =>
      assertDeploymentMatchesProfile({ ...good, eth: { admin: 'X::1220', id: 'ETH' } }, t),
    ).toThrow(/ETH and SOL/)
    const { evm: _evm, ...noEvm } = good
    void _evm
    expect(() => assertDeploymentMatchesProfile(noEvm, t)).toThrow(/evm.custody/)
  })
})

describe('decimal helpers without floats', () => {
  it('floors to 6 decimals at the boundary', () => {
    expect(floorDecimal('100.123456', 6)).toBe('100.123456')
    expect(floorDecimal('100.1234569', 6)).toBe('100.123456')
    expect(floorDecimal('100.0000009', 6)).toBe('100')
    expect(floorDecimal('0.0000009', 6)).toBe('0')
  })
  it('converts USDC units both ways', () => {
    expect(toUnits('1.5', 6)).toBe(1_500_000n)
    expect(toUnits('1.1234567', 6)).toBeNull()
    expect(fromUnits(1_500_000n, 6)).toBe('1.5')
    expect(fromUnits(1n, 6)).toBe('0.000001')
  })
})
