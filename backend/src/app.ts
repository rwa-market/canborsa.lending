import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyServerOptions } from 'fastify'
import { createXreserveClaims } from './assets/claims.ts'
import { assertDeploymentMatchesProfile, DEPOSIT_REASON_PREFIX } from './assets/profiles.ts'
import { createRealAssetsStore } from './assets/store.ts'
import { httpBurnMintFactory } from './assets/utilities.ts'
import { httpEthRpc } from './assets/xreserve.ts'
import { createAuth, sqliteAuthStore } from './auth.ts'
import { createAccountBot } from './bots/accounts.ts'
import { createDepositsBot } from './bots/deposits.ts'
import { createRedeemsBot } from './bots/redeems.ts'
import { createIndexer } from './bots/indexer.ts'
import { createAbsorbBots } from './bots/absorb.ts'
import { createLeaderLease } from './bots/leader.ts'
import { createMaintenance, httpReserveSource } from './bots/maintenance.ts'
import { createOracle } from './bots/oracle.ts'
import {
  buildPriceSources,
  DemoPrices,
  type PriceSource,
  usdcxQuotedAsUsdc,
} from './bots/prices.ts'
import { type BotHandle, createBotRegistry, every, stopAllBots } from './bots/runner.ts'
import { assertSafeBots, type Config, corsOrigins, isPublicNetwork } from './config.ts'
import { createDb } from './db/client.ts'
import { loadDeployment } from './deployment.ts'
import { createLedgerClient } from './ledger/client.ts'
import { createRoleLedgers, tokenSource } from './ledger/credentials.ts'
import { createMetrics } from './metrics.ts'
import { createCommandBuilder } from './protocol/commands.ts'
import { createEvm } from './protocol/evm.ts'
import { createGovernance } from './protocol/governance.ts'
import { createLoop } from './protocol/loop.ts'
import { createReader } from './protocol/reader.ts'
import { createRegistry } from './protocol/registry.ts'
import { backstopBalanceSource, healthRoutes, type ReadinessDeps } from './routes/health.ts'
import { protocolRoutes } from './routes/protocol.ts'
import { allowedOrigins } from './session.ts'

/**
 * Log format (B-17): LOG_FORMAT sets it explicitly, independent of NODE_ENV. Without it: JSON
 * under systemd (no TTY) and pino-pretty in a developer terminal.
 */
export function logFormat(
  config: Pick<Config, 'LOG_FORMAT'>,
  isTTY: boolean = !!process.stdout.isTTY,
): 'json' | 'pretty' {
  return config.LOG_FORMAT ?? (isTTY ? 'pretty' : 'json')
}

function loggerOptions(config: Config): NonNullable<FastifyServerOptions['logger']> {
  if (process.env.NODE_ENV === 'test') return false
  if (logFormat(config) === 'json') return { level: config.LOG_LEVEL }
  return { level: config.LOG_LEVEL, transport: { target: 'pino-pretty' } }
}

/**
 * B-3, §9: X-Forwarded-For is trusted only from TRUSTED_PROXIES addresses. `true` would trust
 * the whole chain, and req.ip would be the leftmost address sent by the client.
 */
export const trustProxyOption = (c: Pick<Config, 'TRUSTED_PROXIES'>): string[] | false =>
  c.TRUSTED_PROXIES.length ? c.TRUSTED_PROXIES : false

/** Data-free paths: polled by the deploy, nginx and monitoring via the slot's local address. */
const PROBES = new Set(['/health', '/health/ready', '/metrics'])

/** How long to wait for in-flight bot steps on shutdown (B-14). */
export const BOT_STOP_TIMEOUT_MS = 15_000

export async function buildApp(config: Config, opts: { withProtocol?: boolean } = {}) {
  const app = Fastify({
    logger: loggerOptions(config),
    bodyLimit: 1_000_000,
    trustProxy: trustProxyOption(config),
    // Long ids in the path: party (/accounts/:party, UUID hint + fingerprint, ≤ 257) and
    // Canton contract id (138+ chars, /governance/:kind/:cid/:action). The Fastify default is
    // 100, so such requests got 414 before reaching the handler
    maxParamLength: 512,
  })

  // B-17: security headers; the API serves only JSON, no pages
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    reply.header('cache-control', 'no-store')
    return payload
  })

  // Host from the list: a page from a foreign domain cannot reach localhost (audit N8)
  const allowed = new Set(config.ALLOWED_HOSTS)
  app.addHook('onRequest', async (req, reply) => {
    if (process.env.NODE_ENV === 'test') return
    if (PROBES.has(req.url)) return
    if (!allowed.has(req.headers.host ?? ''))
      return reply.status(421).send({ error: 'host not allowed' })
  })
  await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' })
  await app.register(cors, { origin: corsOrigins(config.CORS_ORIGIN) })

  const metrics = createMetrics()
  const bots = createBotRegistry(config.BOT_ERROR_THRESHOLD)
  const publicNet = isPublicNetwork(config.LEDGER_NETWORK)

  if (!(opts.withProtocol ?? true)) {
    const ledger = createLedgerClient(
      { LEDGER_API_URL: config.LEDGER_API_URL, LEDGER_USER_ID: config.credentials.default?.userId },
      await tokenSource(config.credentials.default),
    )
    await app.register(healthRoutes(ledger, { metrics, release: config.RELEASE_SHA ?? null }))
    return app
  }

  const deployment = loadDeployment(config.DEPLOYMENT_PATH)
  // Profile real: deployment.json must describe exactly the network's instruments (fail-closed)
  const profile = config.realProfile
  if (profile) assertDeploymentMatchesProfile(deployment, profile)
  const roleLedgers = await createRoleLedgers(
    {
      LEDGER_API_URL: config.LEDGER_API_URL,
      LEDGER_PAGE_SIZE: config.LEDGER_PAGE_SIZE,
      LEDGER_MAX_PAGES: config.LEDGER_MAX_PAGES,
      credentials: config.credentials,
      publicNetwork: publicNet,
    },
    deployment,
  )
  const ledger = roleLedgers.ledger
  const reader = createReader(ledger, deployment, {
    cacheMs: config.READ_CACHE_MS,
    rolesRefreshMs: config.ROLES_REFRESH_MS,
  })
  // The validator's scan-proxy (Amulet registry) accepts a ledger token: use the operator
  // credential
  const operatorToken = roleLedgers.tokens.operator ?? roleLedgers.tokens.default
  const registry = createRegistry(
    config,
    ledger,
    deployment,
    operatorToken ? () => operatorToken.header() : undefined,
  )
  const db = createDb(config.DATABASE_PATH)
  const commands = createCommandBuilder(deployment, reader, registry)
  // EVM wallets (0.5.0) are off by default (EVM_WALLETS): no /auth/evm/* or /evm/* routes,
  // no /config.evm, the faucet does not pay EVM addresses
  const evm = createEvm(deployment, ledger, reader, commands, { enabled: config.EVM_WALLETS })
  // Loop (0.7.0): the same custodian as for EVM accounts; LOOP_WALLETS defaults to DevNet
  const loop = createLoop(deployment, ledger, reader, commands, { enabled: config.LOOP_WALLETS })
  const auth = createAuth(config.AUTH_SECRET, Date.now, {
    sessionTtlMs: config.SESSION_TTL_MS,
    store: sqliteAuthStore(db),
  })
  const demoPrices = new DemoPrices(JSON.parse(config.DEMO_PRICES) as Record<string, string>)
  const liveSources = (): PriceSource[] => buildPriceSources(config)
  const demo = config.ORACLE_MODE === 'demo'
  const publish = createOracle(
    ledger,
    deployment,
    demo ? demoPrices.sources() : liveSources(),
    app.log,
    {
      minSources: config.ORACLE_MIN_SOURCES,
      maxSourceDeviation: config.ORACLE_MAX_SOURCE_DEVIATION,
      fallbackSourceDeviation: config.ORACLE_FALLBACK_SOURCE_DEVIATION,
      publishDeviation: config.ORACLE_PUBLISH_DEVIATION,
      heartbeatMs: config.ORACLE_HEARTBEAT_MS,
      freshQuoteMs: config.ORACLE_FRESH_QUOTE_MS,
      // demo: a human changes the price, jumps are expected
      maxStep: demo ? null : config.ORACLE_MAX_STEP,
      stepConfirmations: config.ORACLE_STEP_CONFIRMATIONS,
      bounds: demo ? {} : config.ORACLE_BOUNDS,
      staleCycles: config.ORACLE_STALE_CYCLES,
      usdcxDepegBound: demo ? null : config.ORACLE_USDCX_DEPEG_BOUND,
    },
    metrics,
  )
  // B-7: there is no public USDCx feed; a quote via USDC does not see a USDCx depeg from USDC
  if (!demo && config.BOTS.includes('oracle')) {
    const proxy = usdcxQuotedAsUsdc(config)
    metrics.gauge(
      'oracle_usdcx_proxy_source',
      '1 — every USDCx source actually quotes USDC',
      proxy ? 1 : 0,
    )
    if (proxy)
      app.log.warn(
        'USDCx is quoted through USDC sources: set ORACLE_SOURCES.usdcx to a USDCx source (ORACLE_HTTP_SOURCES) to see a USDCx/USDC depeg',
      )
  }
  const absorbBots = createAbsorbBots(ledger, reader, commands, deployment, app.log, {
    buyTolerance: config.BUY_TOLERANCE,
    backstopDelayMs: config.BACKSTOP_DELAY_MS,
    absorbAlertMs: config.ABSORB_ALERT_MS,
    stockAlertMs: config.STOCK_ALERT_MS,
  })
  const maintenance = createMaintenance(
    ledger,
    reader,
    registry,
    deployment,
    config.ATTESTATION_MODE ?? config.ORACLE_MODE,
    app.log,
    config.RESERVE_ATTESTATION_URL ? httpReserveSource(config.RESERVE_ATTESTATION_URL) : undefined,
  )
  // Real assets: tables, DA Utilities bridge, Ethereum RPC; only with profile real
  const real = profile
    ? (() => {
        const custody = deployment.evm!.custody
        const store = createRealAssetsStore(db.sqlite)
        const burnMint = httpBurnMintFactory({
          backendUrl: config.UTILITIES_BACKEND_URL ?? profile.utilitiesBackend,
          timeoutMs: config.UTILITIES_TIMEOUT_MS,
        })
        const claims = config.ETH_RPC_URL
          ? createXreserveClaims({
              ledger,
              reader,
              ensureAccount: (a) => evm.ensureAccount(a),
              operator: deployment.operator,
              store,
              rpc: httpEthRpc({ url: config.ETH_RPC_URL, timeoutMs: config.ETH_RPC_TIMEOUT_MS }),
              burnMint,
              custody,
              usdcx: profile.instruments.usdcx,
              xreserve: profile.xreserve,
              minConfirmations: config.ETH_MIN_CONFIRMATIONS,
              depositEvent: config.XRESERVE_DEPOSIT_EVENT,
              metrics,
              log: app.log,
            })
          : undefined
        if (!claims && config.SERVE_API)
          app.log.warn('ETH_RPC_URL is not set: xReserve deposits cannot be claimed')
        return {
          store,
          burnMint,
          routes: {
            info: {
              enabled: true,
              profile: 'real' as const,
              instruments: { ...profile.instruments },
              custody,
              depositReasonPrefix: DEPOSIT_REASON_PREFIX,
              xreserve: claims
                ? {
                    chainId: profile.xreserve.chainId,
                    contract: profile.xreserve.contract,
                    usdc: profile.xreserve.usdc,
                    cantonDomain: profile.xreserve.cantonDomain,
                    recipient: custody,
                    maxFee: config.XRESERVE_MAX_FEE,
                  }
                : null,
            },
            ...(claims ? { claims } : {}),
          },
        }
      })()
    : null
  const indexer = createIndexer(ledger, deployment, db, 200, {
    log: app.log,
    metrics,
    resetOnLedgerChange: config.INDEXER_RESET_ON_LEDGER_CHANGE,
  })

  // Readiness reads the pool as the operator; a process without that credential gets no snapshot
  let canReadProtocol = true
  try {
    ledger.routeOf(deployment.operator, 'read')
  } catch {
    canReadProtocol = false
  }
  // N5: backstop balance only in the process that reads it with its own credential
  let canReadBackstop = true
  try {
    ledger.routeOf(deployment.backstop, 'read')
  } catch {
    canReadBackstop = false
  }
  const absorbRunning = config.BOTS.some((b) => ['absorber', 'liquidator', 'backstop'].includes(b))
  const readinessDeps: ReadinessDeps = {
    deployment,
    bots,
    ...(absorbRunning ? { absorb: absorbBots.signals } : {}),
    metrics,
    credentials: roleLedgers.status,
    maxIndexerLag: config.READY_MAX_INDEXER_LAG,
    collateralAlertUsd: config.COLLATERAL_ALERT_USD,
    reservesAlertUsd: config.RESERVES_ALERT_USD,
    release: config.RELEASE_SHA ?? null,
    ...(canReadProtocol ? { reader } : {}),
    ...(config.BOTS.includes('indexer') ? { indexerLag: indexer.lag } : {}),
    ...(canReadBackstop
      ? {
          backstop: {
            min: config.BACKSTOP_MIN_BALANCE,
            balance: backstopBalanceSource(reader, deployment, (p) => ledger.routeOf(p, 'read')),
          },
        }
      : {}),
  }
  await app.register(healthRoutes(ledger, readinessDeps))

  if (config.SERVE_API)
    await app.register(
      protocolRoutes({
        deployment,
        ledger,
        reader,
        commands,
        auth,
        testFaucet: config.TEST_FAUCET,
        networkId: config.NETWORK_ID ?? null,
        network: { name: config.LEDGER_NETWORK, synchronizerId: config.SYNCHRONIZER_ID ?? null },
        allowedOrigins: allowedOrigins(config),
        commandRatePerPartyPerMinute: config.COMMAND_RATE_PER_PARTY_PER_MINUTE,
        buyTolerance: config.BUY_TOLERANCE,
        history: indexer.history,
        evm,
        loop,
        loopAppName: config.LOOP_APP_NAME,
        governance: createGovernance(deployment, reader, registry),
        ...(real ? { realAssets: real.routes } : {}),
      }),
    )

  assertSafeBots(config)
  const m = config.MONITOR_INTERVAL_MS
  // Third element is the lock: accounts and indexer do not touch Pool and PriceFeed (audit H4)
  const steps: Record<string, [number, () => Promise<unknown>, string?]> = {
    oracle: [config.ORACLE_INTERVAL_MS, () => publish()],
    accounts: [
      3_000,
      createAccountBot(ledger, reader, deployment, app.log, {
        opensPerDay: config.ACCOUNT_OPENS_PER_DAY,
      }),
      'accounts',
    ],
    absorber: [m, absorbBots.absorber],
    liquidator: [m, absorbBots.liquidator],
    backstop: [m, absorbBots.backstop],
    attestation: [600_000, maintenance.attestation],
    merge: [300_000, maintenance.merge],
    logins: [120_000, maintenance.logins, 'accounts'],
    indexer: [5_000, indexer.step, 'indexer'],
    // Real assets: own lock; custodian transfers do not touch Pool and PriceFeed
    ...(real && profile
      ? {
          deposits: [
            config.DEPOSITS_INTERVAL_MS,
            createDepositsBot({
              ledger,
              reader,
              evm,
              registry,
              store: real.store,
              deployment,
              profile,
              log: app.log,
              metrics,
            }),
            'custody',
          ] as [number, () => Promise<unknown>, string],
          redeems: [
            config.REDEEMS_INTERVAL_MS,
            createRedeemsBot({
              ledger,
              reader,
              store: real.store,
              burnMint: real.burnMint,
              deployment,
              profile,
              log: app.log,
              metrics,
            }),
            'custody',
          ] as [number, () => Promise<unknown>, string],
        }
      : {}),
  }
  let handles: BotHandle[] = []
  const start = () => {
    handles = config.BOTS.map((name) => {
      const [interval, step, lock] = steps[name]!
      return every(name, interval, step, app.log, lock, bots)
    })
  }
  /** B-14: clear timers and wait for in-flight steps, and only then release the lease. */
  const stopAll = async () => {
    const current = handles
    handles = []
    if (!(await stopAllBots(current, BOT_STOP_TIMEOUT_MS)))
      app.log.warn('bot steps did not finish in time, stopping anyway')
  }
  if (config.BOTS_LEASE_FILE && config.BOTS.length > 0) {
    // Blue/green: bots run only on the lease holder; the new slot waits for the old one to release
    const lease = createLeaderLease({ file: config.BOTS_LEASE_FILE })
    const aborted = new AbortController()
    void lease
      .acquire(aborted.signal, () => {
        app.log.warn('bot lease lost, bots stopped')
        void stopAll()
      })
      .then((ok) => {
        if (!ok) return
        app.log.info({ bots: config.BOTS }, 'bot lease acquired, bots started')
        start()
      })
    app.addHook('onClose', async () => {
      aborted.abort()
      await stopAll()
      lease.release()
      db.sqlite.close()
    })
  } else {
    start()
    app.addHook('onClose', async () => {
      await stopAll()
      db.sqlite.close()
    })
  }

  return app
}
