import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  ASSET_PROFILES,
  type AssetProfileName,
  REAL_PROFILES,
  type RealProfile,
} from './assets/profiles.ts'
import { BOT_ROLES, type LedgerRole, parseCredentials } from './ledger/credentials.ts'

/** Bots before the Compound V3 model: their replacement, or null if they are gone. */
const LEGACY_BOTS: Record<string, string | null> = {
  monitor: 'absorber',
  settle: null,
  sweep: null,
}

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
const json = <T extends z.ZodType>(inner: T, fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v, ctx) => {
      try {
        return JSON.parse(v) as unknown
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid JSON' })
        return z.NEVER
      }
    })
    .pipe(inner)
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'decimal string')

export const LEDGER_NETWORKS = ['devnet', 'testnet', 'mainnet'] as const
export type LedgerNetwork = (typeof LEDGER_NETWORKS)[number]
/** Networks with real assets and third-party registries: dev modes and shared user are banned. */
export const isPublicNetwork = (n: LedgerNetwork) => n === 'testnet' || n === 'mainnet'

/** Instrument slot in deployment.json: price sources and registries use it, not the symbol. */
export const INSTRUMENT_SLOTS = ['usdcx', 'cc', 'cbtc'] as const
export type InstrumentSlot = (typeof INSTRUMENT_SLOTS)[number]
/** Slots present in every deployment. */
export const CORE_SLOTS = ['usdcx', 'cc', 'cbtc'] as const satisfies readonly InstrumentSlot[]
/** Old symbol keys (COINGECKO_IDS before A-4): USDCx → usdcx etc. */
export const SYMBOL_SLOT: Record<string, InstrumentSlot> = {
  USDCx: 'usdcx',
  CC: 'cc',
  CBTC: 'cbtc',
}
const slotKeyed = <T extends z.ZodType>(value: T) =>
  z.record(z.string(), value).transform((r, ctx) => {
    const out: Partial<Record<InstrumentSlot, z.infer<T>>> = {}
    for (const [k, v] of Object.entries(r)) {
      const slot = (INSTRUMENT_SLOTS as readonly string[]).includes(k)
        ? (k as InstrumentSlot)
        : SYMBOL_SLOT[k]
      if (!slot) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown instrument ${k}: use usdcx, cc or cbtc`,
        })
        return z.NEVER
      }
      out[slot] = v
    }
    return out
  })

const registryEntry = z.union([
  z.url(),
  z.object({ url: z.url(), auth: z.enum(['none', 'ledger']).default('none') }),
])

const httpSource = z.object({
  name: z.string().min(1),
  /** URL with {id}: the coin id at the source from `ids` */
  url: z.string().includes('{id}'),
  ids: slotKeyed(z.string()),
  /** Dot path to the price in JSON, e.g. data.price */
  pricePath: z.string(),
  /** Path to the quote time (ISO or unix seconds); without it the quote is not accepted */
  timePath: z.string(),
})

const bounds = z.object({ min: decimalString, max: decimalString })

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Log format: json (systemd, log collection) or pretty (terminal). Unset: pretty only
   * in a TTY. Independent of NODE_ENV: a prod build can be read by eye and vice versa.
   */
  LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
  /** Release commit: /health returns it, the deploy checks the slot runs the right build. */
  RELEASE_SHA: z
    .string()
    .regex(/^[0-9a-zA-Z._+-]{1,64}$/, 'RELEASE_SHA: commit hash or release tag')
    .optional(),
  /** devnet | testnet | mainnet. On testnet/mainnet the faucet and demo modes are banned (§7). */
  LEDGER_NETWORK: z.enum(LEDGER_NETWORKS).default('devnet'),
  LEDGER_API_URL: z.url().default('http://localhost:7575'),
  /** ACS page size (active-contracts-page) and max pages per request (B-4). */
  LEDGER_PAGE_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
  LEDGER_MAX_PAGES: z.coerce.number().int().min(1).default(200),
  DEPLOYMENT_PATH: z.string().default('./deployment.json'),
  DATABASE_PATH: z.string().default('./data/lending.db'),
  /** Frontend origins, comma-separated (CORS and cookie CSRF). Unset: ALLOWED_HOSTS only. */
  CORS_ORIGIN: z.string().optional(),
  /** Allowed Host header values (DNS rebinding protection). */
  ALLOWED_HOSTS: list('localhost:3001,127.0.0.1:3001,localhost:5173,127.0.0.1:5173'),
  /** Session signing secret. Required with ledger credentials and in prod; random in tests. */
  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET must be at least 32 characters: openssl rand -hex 32')
    .optional(),
  /** API session lifetime (B-18), ms. */
  SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(12 * 3_600_000)
    .default(2 * 3_600_000),
  /** Wallet network the protocol runs on (CIP-0103 networkId), e.g. canton:devnet. */
  NETWORK_ID: z.string().optional(),
  /** Protocol synchronizer for /config.network; without it, the Pool contract's synchronizer. */
  SYNCHRONIZER_ID: z.string().optional(),
  /**
   * Test token faucet for any signed-in party (POST /faucet): the test token registry
   * offers a transfer, the user accepts it with their wallet. DevNet only:
   * on testnet/mainnet startup is refused.
   */
  TEST_FAUCET: bool.default(false),
  /**
   * Loop wallet sign-in (0.7.0): a LoopWallet account under the deployment.json evm.custody
   * custodian. Unset: on for DevNet, off for testnet/mainnet. Always off without a custodian.
   */
  LOOP_WALLETS: bool.optional(),
  /**
   * EVM wallet sign-in (0.5.0, ADR-004): /auth/evm/*, /evm/*, /config.evm and the faucet for
   * EVM addresses. Off by default: users sign in only with Loop (ADR-006). The code and
   * Daml templates stay (EvmWallet on the ledger); the flag only skips registering the routes.
   * Real assets (REAL_ASSETS) go through /evm/* and require EVM_WALLETS=true.
   */
  EVM_WALLETS: bool.default(false),
  /** appName for `loop.init` in the frontend (/config.loop). */
  LOOP_APP_NAME: z.string().min(1).max(64).default('Canton Lending'),
  /** The process serves the protocol HTTP API; false means a bots-only process (B-1). */
  SERVE_API: bool.default(true),
  /**
   * Bots in this process: oracle, accounts, absorber, liquidator, backstop, attestation, merge,
   * logins, indexer; with ASSET_PROFILE=real also deposits and redeems. Names of the bots before
   * the Compound V3 model map onto the new ones: monitor → absorber; settle and sweep are gone
   * (absorb needs no execution step).
   */
  BOTS: list('').transform((names) => [
    ...new Set(
      names
        .map((n) => (Object.hasOwn(LEGACY_BOTS, n) ? (LEGACY_BOTS[n] ?? null) : n))
        .filter((n): n is string => n !== null),
    ),
  ]),
  ORACLE_MODE: z.enum(['demo', 'live']).default('demo'),
  /**
   * CBTC reserve attestation: live uses only the Proof of Reserve source (RESERVE_ATTESTATION_URL),
   * demo re-signs with the same coverage. Defaults to ORACLE_MODE. DevNet: live prices, but
   * test CBTC has no PoR source, so ATTESTATION_MODE=demo. demo is not allowed on TestNet/MainNet.
   */
  ATTESTATION_MODE: z.enum(['demo', 'live']).optional(),
  /** Blue/green: lease file; bots run in only one of the two processes. */
  BOTS_LEASE_FILE: z.string().optional(),
  /** Deprecated (B-3): used to trust the whole XFF chain. Now only a "behind a proxy" flag. */
  TRUST_PROXY: bool.default(false),
  /** Proxy addresses whose X-Forwarded-For we trust (§9). Empty: nobody. */
  TRUSTED_PROXIES: list('127.0.0.1'),
  ORACLE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  /** Buyer bots: minimum to receive = quote × (1 − tolerance); 0.02 = 2 %. */
  BUY_TOLERANCE: z
    .string()
    .regex(/^0(\.\d{1,6})?$/, 'a fraction below 1, e.g. 0.02')
    .default('0.02'),
  /** The backstop buys absorbed collateral that has waited this long, ms. */
  BACKSTOP_DELAY_MS: z.coerce.number().int().min(0).default(120_000),
  /** /health/ready: an absorbable account not absorbed for this long is a problem, ms. */
  ABSORB_ALERT_MS: z.coerce.number().int().min(1_000).default(300_000),
  /** /health/ready: absorbed collateral unsold for this long is a problem, ms. */
  STOCK_ALERT_MS: z.coerce.number().int().min(1_000).default(1_800_000),
  /**
   * /health/ready, risk 6: users' collateral of one market worth more than this, USD, is a
   * problem (supplyCap is in units; at launch prices the caps hold about $50,000).
   */
  COLLATERAL_ALERT_USD: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default('75000'),
  /**
   * /health/ready, К6: net reserves below this, USDCx, are a problem. 0: only negative net reserves,
   * when the contract closes loans and deposit withdrawals; TestNet sets the starting 15000.
   */
  RESERVES_ALERT_USD: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default('0'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** D-7: command preparations (POST /commands, /treasury, /governance, /admin) per party/min. */
  COMMAND_RATE_PER_PARTY_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Cache of the Pool/Config/PriceFeed snapshot for API reads (B-4), ms; 0 means no cache. */
  READ_CACHE_MS: z.coerce.number().int().min(0).max(10_000).default(1_500),
  /** How often to reread roles from ProtocolConfig (§4), ms. */
  ROLES_REFRESH_MS: z.coerce.number().int().min(1_000).default(30_000),
  /** Consecutive errors after which a bot is in error state (B-10). */
  BOT_ERROR_THRESHOLD: z.coerce.number().int().min(1).default(3),
  /** Limit of new accounts per day (B-16). */
  ACCOUNT_OPENS_PER_DAY: z.coerce.number().int().min(1).default(500),
  /**
   * Token registry: ledger means the test token's TokenRules from own node's ACS (DevNet, protocol
   * registries), http means the CIP-0056 Registry API of third-party registries (TestNet, MainNet).
   */
  TOKEN_REGISTRY: z.enum(['ledger', 'http']).optional(),
  /** Registry URL per instrument: {"usdcx":"https://…","cc":{"url":"https://…/scan-proxy","auth":"ledger"}}. */
  TOKEN_REGISTRY_URLS: json(slotKeyed(registryEntry), '{}'),
  TOKEN_REGISTRY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  TOKEN_REGISTRY_CACHE_MS: z.coerce.number().int().min(0).default(5_000),
  /** Initial demo oracle prices. */
  DEMO_PRICES: z.string().default('{"USDCx":"1","CC":"0.2","CBTC":"100000"}'),
  /**
   * Live oracle sources (B-7). A comma-separated list applies to all instruments, as before.
   * JSON keyed by InstrumentId slot from deployment.json: USDCx sources separate from USDC:
   * {"usdcx":["xreserve","coingecko"],"cc":["coingecko","coinpaprika"],"cbtc":[...]}.
   * Names: coingecko, coinpaprika, kucoin, binance, bybit or a name from ORACLE_HTTP_SOURCES.
   */
  ORACLE_SOURCES: z
    .string()
    .default('coingecko,kucoin,binance,bybit')
    .transform((v, ctx): Record<InstrumentSlot, string[]> => {
      if (!v.trim().startsWith('{')) {
        const names = v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        return { usdcx: names, cc: [...names], cbtc: [...names] }
      }
      let raw: unknown
      try {
        raw = JSON.parse(v)
      } catch {
        ctx.addIssue({ code: 'custom', message: 'ORACLE_SOURCES: invalid JSON' })
        return z.NEVER
      }
      const r = slotKeyed(z.array(z.string().min(1))).safeParse(raw)
      if (!r.success) {
        ctx.addIssue({ code: 'custom', message: `ORACLE_SOURCES: ${r.error.issues[0]?.message}` })
        return z.NEVER
      }
      const missing = CORE_SLOTS.filter((slot) => !r.data[slot])
      if (missing.length) {
        ctx.addIssue({
          code: 'custom',
          message: `ORACLE_SOURCES: name the sources of ${missing.join(', ')} too`,
        })
        return z.NEVER
      }
      return r.data as Record<InstrumentSlot, string[]>
    }),
  /**
   * USDCx depeg bound (B-7): a median further than this fraction from 1 raises an alert and the
   * metric oracle_usdcx_depeg. The price is published anyway: borrowing on depeg is closed by the
   * contract
   * (maxDebtDepeg).
   */
  ORACLE_USDCX_DEPEG_BOUND: z
    .string()
    .regex(/^0(\.\d{1,6})?$/, 'a fraction below 1, e.g. 0.02')
    .default('0.02'),
  /** Coin ids per instrument slot (usdcx, cc, cbtc; old keys USDCx/CC/CBTC too). */
  COINGECKO_IDS: json(
    slotKeyed(z.string()),
    '{"usdcx":"usd-coin","cc":"canton-network","cbtc":"bitcoin"}',
  ),
  /** KuCoin pairs against USDT per slot: public API without a key or monthly quota. */
  KUCOIN_IDS: json(slotKeyed(z.string()), '{"usdcx":"USDC-USDT","cc":"CC-USDT","cbtc":"BTC-USDT"}'),
  /** Binance pairs against USDT per slot; CC is not on Binance. */
  BINANCE_IDS: json(slotKeyed(z.string()), '{"usdcx":"USDCUSDT","cbtc":"BTCUSDT"}'),
  /**
   * Bybit pairs against USDT per slot. CC trades here, so CC has three sources (CoinGecko, KuCoin,
   * Bybit): one lagging or rate-limited source no longer leaves CC without a fresh price.
   */
  BYBIT_IDS: json(slotKeyed(z.string()), '{"usdcx":"USDCUSDT","cc":"CCUSDT","cbtc":"BTCUSDT"}'),
  COINPAPRIKA_IDS: json(
    slotKeyed(z.string()),
    '{"usdcx":"usdc-usd-coin","cc":"cc-canton-network","cbtc":"btc-bitcoin"}',
  ),
  /** Extra HTTP sources: [{name,url,ids,pricePath,timePath}]. */
  ORACLE_HTTP_SOURCES: json(z.array(httpSource), '[]'),
  /** How many agreeing sources are needed to publish (the contract requires ≥ 2). */
  ORACLE_MIN_SOURCES: z.coerce.number().int().min(2).default(2),
  /** The sources must agree within this to publish (contract: maxSourceDeviation = 0.03). */
  ORACLE_MAX_SOURCE_DEVIATION: decimalString.default('0.03'),
  /**
   * Review 03.10, item 12: when no group of ORACLE_MIN_SOURCES agrees within the line above, quotes
   * up to this spread are still published (contract: maxLiquidationSourceDeviation = 0.15). The
   * feed stays fresh for absorbs and sales while the contract closes new loans itself; a lone bad
   * source among three is still dropped, since the other two agree strictly.
   */
  ORACLE_FALLBACK_SOURCE_DEVIATION: decimalString.default('0.15'),
  /** Publish if the median moved further than this fraction from the ledger price (B-7). */
  ORACLE_PUBLISH_DEVIATION: decimalString.default('0.005'),
  /**
   * With enough agreeing quotes, older ones are left out of a publish, ms: the feed is as old as
   * its oldest quote, so this keeps it valid ≥ 300 s − this after a publish (review 08.10, item 1).
   */
  ORACLE_FRESH_QUOTE_MS: z.coerce.number().int().positive().default(120_000),
  /** Publish at least this often, ms; less than maxPriceAgeSeconds = 300 s. */
  ORACLE_HEARTBEAT_MS: z.coerce.number().int().positive().default(240_000),
  /** A jump larger than this fraction per update is published only after confirmation. */
  ORACLE_MAX_STEP: decimalString.default('0.2'),
  /** How many cycles in a row a jump must repeat to be published. */
  ORACLE_STEP_CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
  /** Price sanity bounds per slot: {"cc":{"min":"0.001","max":"100"}}. */
  ORACLE_BOUNDS: json(
    slotKeyed(bounds),
    '{"usdcx":{"min":"0.5","max":"1.5"},"cc":{"min":"0.0001","max":"1000"},"cbtc":{"min":"1000","max":"10000000"}}',
  ),
  /** After this many cycles without publishing: error in the log and in /health/ready. */
  ORACLE_STALE_CYCLES: z.coerce.number().int().min(1).default(5),
  /** CBTC Proof of Reserve (B-8): JSON {coverage, attestedAt} or {reserves, supply, asOf}. */
  RESERVE_ATTESTATION_URL: z.url().optional(),
  /** N5: /health/ready warns when backstop has less USDCx (§5 of the spec). */
  BACKSTOP_MIN_BALANCE: decimalString.default('25000'),
  /** Indexer lag after which /health/ready is not ready, in offsets. */
  READY_MAX_INDEXER_LAG: z.coerce.number().int().min(1).default(10_000),
  /** The ledger or participant under the old database changed: wipe the history and start over. */
  INDEXER_RESET_ON_LEDGER_CHANGE: bool.default(false),

  // Real assets (seam 2, ADR-005) ------------------------------------------------
  /**
   * Master switch for real assets. false (default): everything as on DevNet:
   * test tokens, no deposits/redeems bots, no claim, no /config.realAssets.
   */
  REAL_ASSETS: bool.default(false),
  /** test: deployment test tokens; real: the network's CC, USDCx, CBTC (testnet/mainnet only). */
  ASSET_PROFILE: z.enum(ASSET_PROFILES).default('test'),
  /** Ethereum JSON-RPC (Sepolia for testnet): xReserve deposit checks. May carry a secret key. */
  ETH_RPC_URL: z.url().optional(),
  ETH_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Deposit block confirmations before crediting. */
  ETH_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(12),
  /**
   * TODO(config): xReserve deposit event, human-readable ABI
   * (`event X(address indexed …)`). It is not in the Circle docs; without it the check uses
   * the depositToRemote calldata and the USDC Transfer log.
   */
  XRESERVE_DEPOSIT_EVENT: z.string().startsWith('event ').optional(),
  /** xReserve fee ceiling for the frontend, USDC units (TODO(config): the fee is not published). */
  XRESERVE_MAX_FEE: z.string().regex(/^\d+$/).default('0'),
  /** DA Utilities backend (burn-mint-factory); defaults to the network profile. */
  UTILITIES_BACKEND_URL: z.url().optional(),
  UTILITIES_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** TODO(config): custodian's CC TransferPreapproval provider (usually the validator operator). */
  CC_PREAPPROVAL_PROVIDER: z.string().optional(),
  DEPOSITS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  REDEEMS_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  /** RedStone (source redstone in ORACLE_SOURCES). Without a key the source is off. */
  REDSTONE_API_KEY: z.string().min(1).optional(),
  REDSTONE_API_URL: z.url().default('https://api.redstone.finance'),
  REDSTONE_IDS: json(slotKeyed(z.string()), '{"usdcx":"USDC","cc":"CC","cbtc":"BTC"}'),
  /** Kaiko (source kaiko). Off without a key. */
  KAIKO_API_KEY: z.string().min(1).optional(),
  KAIKO_API_URL: z.url().default('https://us.market-api.kaiko.io'),
  KAIKO_IDS: json(slotKeyed(z.string()), '{"usdcx":"usdc","cc":"cc","cbtc":"btc"}'),
  /** Chainlink Data Streams (source chainlink): key, HMAC secret and feedID per slot. */
  CHAINLINK_STREAMS_API_KEY: z.string().min(1).optional(),
  CHAINLINK_STREAMS_API_SECRET: z.string().min(1).optional(),
  CHAINLINK_STREAMS_URL: z.url().default('https://api.dataengine.chain.link'),
  /** TODO(config): V3 report feedID per slot, {"cbtc":"0x…"}; issued by Chainlink. */
  CHAINLINK_FEED_IDS: json(slotKeyed(z.string().regex(/^0x[0-9a-fA-F]{64}$/)), '{}'),
})

type Parsed = z.infer<typeof schema>

export type Config = Omit<Parsed, 'TOKEN_REGISTRY' | 'CORS_ORIGIN' | 'LOOP_WALLETS'> & {
  AUTH_SECRET: string
  /** LOOP_WALLETS with a per-network default: DevNet is true */
  LOOP_WALLETS: boolean
  CORS_ORIGIN: string
  TOKEN_REGISTRY: 'ledger' | 'http'
  /** The network's real asset profile; null means profile test (DevNet and the old behavior). */
  realProfile: RealProfile | null
  /** Whether TRUSTED_PROXIES is set explicitly (the "behind a proxy" flag for B-6). */
  behindProxy: boolean
  credentials: ReturnType<typeof parseCredentials>
}

/** CORS_ORIGIN as a list for @fastify/cors: a comma-separated string would go to the header raw. */
export const corsOrigins = (v: string) =>
  v
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean)

/**
 * Ledger roles the process needs: bots and the API (the operator consumes Logins, reads the pool).
 * With profile real the API submits EVM wallet operations as the custodian, so its credential is
 * required.
 */
export function rolesInUse(
  c: Pick<Parsed, 'BOTS' | 'SERVE_API'> & { ASSET_PROFILE?: AssetProfileName },
): LedgerRole[] {
  const roles = new Set<LedgerRole>(c.SERVE_API ? ['operator'] : [])
  if (c.SERVE_API && c.ASSET_PROFILE === 'real') roles.add('custody')
  for (const bot of c.BOTS) for (const r of BOT_ROLES[bot] ?? []) roles.add(r)
  return [...roles]
}

/** Bots that run only with profile real. */
export const REAL_ASSET_BOTS = ['deposits', 'redeems'] as const
/** Price sources keyed by API key: a name in ORACLE_SOURCES without a key refuses startup. */
const KEYED_SOURCES: Record<string, (c: Parsed) => boolean> = {
  redstone: (c) => !!c.REDSTONE_API_KEY,
  kaiko: (c) => !!c.KAIKO_API_KEY,
  chainlink: (c) => !!c.CHAINLINK_STREAMS_API_KEY && !!c.CHAINLINK_STREAMS_API_SECRET,
}

/**
 * Real asset flags, fail-closed (seam 2): profile real only together with REAL_ASSETS=true
 * and only on testnet/mainnet; REAL_ASSETS without profile real is also an error (unclear what
 * was meant). The deposits/redeems bots run only under real. Returns the network profile or null.
 */
export function assertAssetProfile(
  c: Pick<Parsed, 'REAL_ASSETS' | 'ASSET_PROFILE' | 'LEDGER_NETWORK' | 'BOTS'>,
): RealProfile | null {
  if (c.ASSET_PROFILE === 'real' && !c.REAL_ASSETS)
    throw new Error('ASSET_PROFILE=real needs REAL_ASSETS=true')
  if (c.REAL_ASSETS && c.ASSET_PROFILE !== 'real')
    throw new Error('REAL_ASSETS=true needs ASSET_PROFILE=real')
  if (c.ASSET_PROFILE === 'real' && c.LEDGER_NETWORK === 'devnet')
    throw new Error('ASSET_PROFILE=real is only for LEDGER_NETWORK=testnet or mainnet')
  const realBots = c.BOTS.filter((b) => (REAL_ASSET_BOTS as readonly string[]).includes(b))
  if (realBots.length && c.ASSET_PROFILE !== 'real')
    throw new Error(`BOTS=${realBots.join(',')} needs ASSET_PROFILE=real and REAL_ASSETS=true`)
  if (c.ASSET_PROFILE !== 'real') return null
  return REAL_PROFILES[c.LEDGER_NETWORK as 'testnet' | 'mainnet']
}

/** Test token faucet is DevNet only: on networks with real assets startup is refused. */
export function assertSafeNetworkConfig(c: Pick<Parsed, 'LEDGER_NETWORK' | 'TEST_FAUCET'>) {
  if (isPublicNetwork(c.LEDGER_NETWORK) && c.TEST_FAUCET)
    throw new Error(`TEST_FAUCET is forbidden with LEDGER_NETWORK=${c.LEDGER_NETWORK}`)
}

/**
 * The attestation bot in demo re-signs the attestation with the same coverage (a stub). In live it
 * publishes only Proof of Reserve source data (B-8); without a source startup is refused.
 */
export function assertSafeBots(
  c: Pick<Parsed, 'BOTS' | 'ORACLE_MODE'> &
    Partial<Pick<Parsed, 'RESERVE_ATTESTATION_URL' | 'ATTESTATION_MODE'>>,
) {
  const attestation = c.ATTESTATION_MODE ?? c.ORACLE_MODE
  if (attestation === 'live' && c.BOTS.includes('attestation') && !c.RESERVE_ATTESTATION_URL)
    throw new Error(
      'BOTS=attestation in live mode needs RESERVE_ATTESTATION_URL (Proof of Reserve source); set ATTESTATION_MODE=demo on DevNet',
    )
  for (const b of c.BOTS) if (!BOT_ROLES[b]) throw new Error(`unknown bot ${b}`)
}

/**
 * Separate ledger users per role (B-1, A-2). On testnet/mainnet every role
 * the process needs must have its own credential, and role credentials must not coincide.
 */
export function assertRoleCredentials(
  c: Pick<Parsed, 'LEDGER_NETWORK' | 'BOTS' | 'SERVE_API'> & { ASSET_PROFILE?: AssetProfileName },
  creds: ReturnType<typeof parseCredentials>,
) {
  if (!isPublicNetwork(c.LEDGER_NETWORK)) return
  const needed = rolesInUse(c)
  const missing = needed.filter((r) => !creds[r])
  if (missing.length)
    throw new Error(
      `LEDGER_NETWORK=${c.LEDGER_NETWORK} needs a separate ledger user per role: set LEDGER_${missing
        .map((r) => r.toUpperCase())
        .join('_*, LEDGER_')}_* (a shared LEDGER_TOKEN is not used here)`,
    )
  const seen = new Map<string, LedgerRole>()
  for (const r of needed) {
    const id = creds[r]!.identity
    const other = seen.get(id)
    if (other) throw new Error(`roles ${other} and ${r} share one ledger user (${id})`)
    seen.set(id, r)
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env)
  const credentials = parseCredentials(env)
  const behindProxy = env.TRUSTED_PROXIES !== undefined && c.TRUSTED_PROXIES.length > 0
  assertSafeNetworkConfig(c)
  const realProfile = assertAssetProfile(c)
  // Real assets: EVM wallet operations (/evm/prepare, /evm/claim-deposit, deposits bot)
  if (c.REAL_ASSETS && !c.EVM_WALLETS) throw new Error('REAL_ASSETS=true needs EVM_WALLETS=true')
  assertSafeBots(c)
  assertRoleCredentials(c, credentials)
  for (const [name, hasKey] of Object.entries(KEYED_SOURCES))
    if (INSTRUMENT_SLOTS.some((s) => c.ORACLE_SOURCES[s].includes(name)) && !hasKey(c))
      throw new Error(`ORACLE_SOURCES names ${name}, but its API key is not set`)
  // Profile real: network registries by default; an explicit TOKEN_REGISTRY_URLS (scan-proxy) wins
  if (realProfile)
    for (const slot of CORE_SLOTS) c.TOKEN_REGISTRY_URLS[slot] ??= realProfile.registries[slot]
  const publicNet = isPublicNetwork(c.LEDGER_NETWORK)
  // B-17: a random secret breaks sessions on every deploy: with a real ledger, only an explicit one
  const realLedger = Object.values(credentials).some(Boolean)
  if (!c.AUTH_SECRET && (realLedger || env.NODE_ENV === 'production'))
    throw new Error('AUTH_SECRET is required with ledger credentials or NODE_ENV=production')
  const registry = c.TOKEN_REGISTRY ?? (publicNet ? 'http' : 'ledger')
  // B-2: the ledger registry reads the ACS on behalf of instrument.admin; not possible with
  // third-party registries
  if (publicNet && registry !== 'http')
    throw new Error(`TOKEN_REGISTRY=ledger is not allowed with LEDGER_NETWORK=${c.LEDGER_NETWORK}`)
  if (registry === 'http') {
    const missing = CORE_SLOTS.filter((s) => !c.TOKEN_REGISTRY_URLS[s])
    if (missing.length)
      throw new Error(`TOKEN_REGISTRY=http needs TOKEN_REGISTRY_URLS for ${missing.join(', ')}`)
  }
  if (publicNet && c.ORACLE_MODE === 'demo' && c.BOTS.includes('oracle'))
    throw new Error(`ORACLE_MODE=demo is not allowed with LEDGER_NETWORK=${c.LEDGER_NETWORK}`)
  if (publicNet && c.ATTESTATION_MODE === 'demo' && c.BOTS.includes('attestation'))
    throw new Error(`ATTESTATION_MODE=demo is not allowed with LEDGER_NETWORK=${c.LEDGER_NETWORK}`)
  return {
    ...c,
    CORS_ORIGIN: c.CORS_ORIGIN ?? '',
    TOKEN_REGISTRY: registry,
    LOOP_WALLETS: c.LOOP_WALLETS ?? !publicNet,
    realProfile,
    AUTH_SECRET: c.AUTH_SECRET ?? randomBytes(32).toString('hex'),
    behindProxy,
    credentials,
  }
}
