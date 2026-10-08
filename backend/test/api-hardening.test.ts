import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import type { Deployment } from '../src/deployment.ts'
import { CommandError, createCommandBuilder, LOGIN_MAX_TTL_MS } from '../src/protocol/commands.ts'
import type { Reader, Snapshot } from '../src/protocol/reader.ts'
import type { TokenRegistry } from '../src/protocol/registry.ts'
import { acceptableLogin } from '../src/routes/protocol.ts'
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
}

describe('API surface without a ledger', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeAll(async () => {
    const path = join(tmpdir(), `deployment-hard-${process.pid}.json`)
    writeFileSync(path, JSON.stringify(deployment))
    app = await buildApp(
      loadConfig({
        LEDGER_API_URL: 'http://127.0.0.1:9',
        DEPLOYMENT_PATH: path,
        AUTH_SECRET: TEST_SECRET,
        DATABASE_PATH: ':memory:',
        NETWORK_ID: 'canton:devnet',
        SYNCHRONIZER_ID: 'global-domain::1220',
      }),
    )
  })
  afterAll(() => app.close())

  it('§10, §4: /config carries the network and the roles (last known without a ledger)', async () => {
    const c = (await app.inject({ method: 'GET', url: '/config' })).json()
    expect(c.network).toEqual({
      name: 'devnet',
      networkId: 'canton:devnet',
      synchronizerId: 'global-domain::1220',
    })
    expect(c.networkId).toBe('canton:devnet')
    expect(c.roles).toMatchObject({
      guardian: deployment.guardian,
      liquidators: [deployment.liquidator],
    })
  })

  it('B-17: security headers on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    })
  })

  it('B-18: logout revokes the session', async () => {
    const own = sessionFor(deployment.alice)
    const history = () =>
      app.inject({
        method: 'GET',
        url: `/history/${encodeURIComponent(deployment.alice)}`,
        headers: { 'x-session-token': own },
      })
    expect((await history()).statusCode).toBe(200)
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'x-session-token': own },
    })
    expect(out.json()).toEqual({ revoked: true })
    expect((await history()).statusCode).toBe(401)
  })

  it('B-10: /health/ready is 503 with the reasons; /metrics answers in Prometheus text', async () => {
    const ready = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json()).toMatchObject({ ready: false, ledger: 'unavailable' })
    expect(ready.json().problems).toContain('ledger is unavailable')
    const metrics = await app.inject({ method: 'GET', url: '/metrics' })
    expect(metrics.statusCode).toBe(200)
    expect(metrics.headers['content-type']).toMatch(/text\/plain/)
  })

  it('A-8: an unreachable ledger answers 503, not a contract rejection', async () => {
    const res = await app.inject({ method: 'GET', url: '/pool' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toMatch(/^UNAVAILABLE/)
  })
})

describe('§2: which Login the backend accepts', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const at = (ms: number) => new Date(now + ms).toISOString()
  it('only with an expiry, not expired and not beyond the cap', () => {
    expect(acceptableLogin(null, now)).toBe(false)
    expect(acceptableLogin(undefined, now)).toBe(false)
    expect(acceptableLogin(at(0), now)).toBe(false)
    expect(acceptableLogin(at(5 * 60_000), now)).toBe(true)
    expect(acceptableLogin(at(LOGIN_MAX_TTL_MS + 60_000), now)).toBe(true)
    expect(acceptableLogin(at(LOGIN_MAX_TTL_MS + 60_001), now)).toBe(false)
    expect(acceptableLogin('2100-01-01T00:00:00Z', now)).toBe(false)
  })
})

// ------------------------------------------------------------------ B-12

const d = deployment as unknown as Deployment
const nowIso = () => new Date().toISOString()
const quotes = (price: string) => [
  { source: 'a', price, observedAt: nowIso() },
  { source: 'b', price, observedAt: nowIso() },
]
function snapshot(): Snapshot {
  const params = {
    debtInstrument: d.usdcx,
    rateModel: {
      baseRate: '0',
      slope1: '0',
      slope2: '0',
      optimalUtilization: '0.8',
      maxUtilization: '0.9',
      reserveFactor: '0',
    },
    totalBorrowCap: '1000000',
    maxDebtPerUser: '1000000',
    minLoan: '1',
    liquidationRiskWarning: '0.71',
    maxPriceAgeSeconds: '300',
    maxSourceDeviation: '0.03',
    maxLiquidationSourceDeviation: '0.15',
    maxDebtDepeg: '0.02',
    maxClockSkewSeconds: '30',
    storeFrontPriceFactor: '0.8',
    targetReserves: '50000',
  }
  return {
    config: {
      contractId: 'cfg',
      payload: {
        roles: {
          operator: d.operator,
          oracle: d.oracle,
          guardian: d.guardian,
          treasury: d.treasury,
          backstop: d.backstop,
          liquidators: [d.liquidator],
        },
        governors: [],
        params,
        marketParams: [],
        transferFactories: [
          [d.usdcx, 'f-usdcx'],
          [d.cbtc, 'f-cbtc'],
          [d.cc, 'f-cc'],
        ],
      },
    },
    pool: {
      contractId: 'pool',
      payload: {
        state: {
          totalSupplyPrincipal: '100000',
          totalBorrowPrincipal: '0',
          supplyIndex: '1',
          borrowIndex: '1',
          cash: '100000',
          lastUpdate: nowIso(),
        },
      },
    },
    pause: {
      contractId: 'pause',
      payload: {
        operator: d.operator,
        guardian: d.guardian,
        flags: {
          borrowPaused: false,
          collateralWithdrawPaused: false,
          supplyWithdrawPaused: false,
          absorbPaused: false,
          buyPaused: false,
        },
      },
    },
    markets: new Map([
      ['CBTC', { totalCollateral: '0.1', protocolCollateral: '0', protocolCollateralBasis: '0' }],
    ]),
    marketParams: new Map([
      [
        'CBTC',
        {
          collateralInstrument: d.cbtc,
          borrowCollateralFactor: '0.7',
          liquidateCollateralFactor: '0.8',
          liquidationFactor: '0.95',
          supplyCap: '1000000',
          minCollateralAmount: '0.00001',
          requiresReserveAttestation: false,
          minReserveCoverage: '1',
          maxAttestationAgeSeconds: '86400',
        },
      ],
    ]),
    feeds: [
      {
        contractId: 'feed-usdcx',
        payload: { oracle: d.oracle, instrumentId: d.usdcx, quotes: quotes('1') },
      },
      {
        contractId: 'feed-cbtc',
        payload: { oracle: d.oracle, instrumentId: d.cbtc, quotes: quotes('40000') },
      },
    ],
    attestations: [],
    featuredAppRight: null,
  } as unknown as Snapshot
}

describe('B-12: no operator holdings disclosure beyond what the contract would pay', () => {
  const alice = deployment.alice
  const account = {
    contractId: 'acc',
    payload: {
      operator: d.operator,
      owner: alice,
      principal: '0',
      collateral: [['CBTC', '0.1']],
    },
  }
  // the operator holds many holdings; they must not be enumerated
  const opHoldings = Array.from({ length: 20 }, (_, i) => ({
    contract: {
      contractId: `op-h${i}`,
      templateId: 't',
      createdEventBlob: 'b',
      synchronizerId: 's',
    },
    view: { owner: d.operator, amount: '10000', instrumentId: d.usdcx, lock: null },
  }))
  const reader = {
    snapshot: async () => snapshot(),
    account: async () => account,
    holdings: async (p: string) => (p === d.operator ? opHoldings : []),
  } as unknown as Reader
  const registry: TokenRegistry = {
    transferFactory: async (_i, cid) => ({
      factoryCid: cid,
      disclosed: [],
      transferExtraArgs: { context: { values: {} }, meta: { values: {} } },
      acceptExtraArgs: { context: { values: {} }, meta: { values: {} } },
    }),
  }
  const commands = createCommandBuilder(d, reader, registry)

  it('withdraw-collateral above the position is refused before the payout', async () => {
    await expect(commands.withdrawCollateral(alice, 'CBTC', '5')).rejects.toBeInstanceOf(
      CommandError,
    )
    const ok = await commands.withdrawCollateral(alice, 'CBTC', '0.05')
    expect(ok.disclosedContracts.filter((c) => c.contractId.startsWith('op-h'))).toHaveLength(1)
  })

  it('borrow above availableToBorrow is refused; the pool cash is not enumerated', async () => {
    // 0.1 CBTC × 40000 × LTV 0.7 = 2800 USDCx
    await expect(commands.borrow(alice, '100000')).rejects.toThrow(/up to 2800\.0/)
    const ok = await commands.borrow(alice, '2000')
    expect(ok.disclosedContracts.filter((c) => c.contractId.startsWith('op-h'))).toHaveLength(1)
  })

  it('a Login expiry beyond 10 minutes is capped', async () => {
    const far = new Date(Date.now() + 3_600_000)
    const cmd = await commands.login(alice, 'n', far)
    const exp = Date.parse(
      (cmd.commands[0] as { CreateCommand: { createArguments: { expiresAt: string } } })
        .CreateCommand.createArguments.expiresAt,
    )
    expect(exp).toBeLessThanOrEqual(Date.now() + LOGIN_MAX_TTL_MS)
  })
})
