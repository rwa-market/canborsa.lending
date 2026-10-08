/**
 * Price sources for the oracle (T3.1.3). demo mode: fixed prices (tests):
 * two sources return the DEMO_PRICES prices.
 * live mode: CoinGecko, CoinPaprika and HTTP sources from ORACLE_HTTP_SOURCES;
 * the quote time comes from the source (audit S4).
 *
 * A-4: quotes are addressed by the deployment.json instrument slot (usdcx, cc, cbtc), not
 * by symbol: Amulet has id = "Amulet", and a lookup by symbol CC did not find it.
 */
import { type Config, INSTRUMENT_SLOTS, type InstrumentSlot, SYMBOL_SLOT } from '../config.ts'
import { chainlink, kaiko, redstone } from './price-adapters.ts'

export interface SourceQuote {
  price: string
  observedAt: string
}

export type SlotQuotes = Partial<Record<InstrumentSlot, SourceQuote>>

export interface PriceSource {
  name: string
  /** Instruments the source quotes for the oracle (B-7); no field means all */
  slots?: InstrumentSlot[]
  fetch(slots: InstrumentSlot[]): Promise<SlotQuotes>
}

/** A number from source JSON to a decimal string without exponent and float noise. */
export function normalizePrice(v: number): string | null {
  if (!Number.isFinite(v) || v <= 0) return null
  return v.toFixed(12).replace(/\.?0+$/, '')
}

/** Demo prices by symbol (USDCx, CC, CBTC): this is how POST /dev/prices changes them. */
export class DemoPrices {
  private prices: Record<string, string>
  constructor(initial: Record<string, string>) {
    this.prices = { ...initial }
  }
  set(symbol: string, price: string) {
    this.prices[symbol] = price
  }
  all() {
    return { ...this.prices }
  }
  sources(): PriceSource[] {
    return ['demo-a', 'demo-b'].map((name) => ({
      name,
      fetch: async () => {
        const observedAt = new Date().toISOString()
        const out: SlotQuotes = {}
        for (const [symbol, price] of Object.entries(this.all())) {
          const slot = SYMBOL_SLOT[symbol]
          if (slot) out[slot] = { price, observedAt }
        }
        return out
      },
    }))
  }
}

async function getJson(url: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
  return res.json()
}

type Ids = Partial<Record<InstrumentSlot, string>>

/** ids: slot → coin id at the source, e.g. { cc: 'canton-network', cbtc: 'bitcoin' }. */
export function coingecko(ids: Ids, fetchImpl?: typeof fetch): PriceSource {
  return {
    name: 'coingecko',
    async fetch(slots) {
      const wanted = slots
        .map((s) => ids[s])
        .filter(Boolean)
        .map((id) => encodeURIComponent(id!))
        .join(',')
      const body = (await getJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${wanted}&vs_currencies=usd&include_last_updated_at=true`,
        fetchImpl,
      )) as Record<string, { usd?: number; last_updated_at?: number }>
      const out: SlotQuotes = {}
      for (const s of slots) {
        const row = body[ids[s] ?? '']
        const price = row?.usd === undefined ? null : normalizePrice(row.usd)
        if (price && row?.last_updated_at)
          out[s] = { price, observedAt: new Date(row.last_updated_at * 1000).toISOString() }
      }
      return out
    },
  }
}

/**
 * Exchange quote against USDT: KuCoin (`/api/v1/market/stats`), Binance (`/api/v3/ticker/24hr`)
 * and Bybit (`/v5/market/recent-trade`).
 * Public APIs without a key and without a monthly quota; the quote time is the exchange time.
 */
function exchange(
  name: string,
  url: (id: string) => string,
  read: (body: unknown) => { price?: unknown; time?: unknown },
): (ids: Ids, fetchImpl?: typeof fetch) => PriceSource {
  return (ids, fetchImpl) => ({
    name,
    async fetch(slots) {
      const out: SlotQuotes = {}
      let failed: unknown = null
      for (const s of slots) {
        const id = ids[s]
        if (!id) continue
        const body = await getJson(url(id), fetchImpl).catch((e: unknown) => {
          failed = e
          return null
        })
        if (!body) continue
        const { price: raw, time } = read(body)
        const price =
          typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw) && Number(raw) > 0 ? raw : null
        const observedAt = toIso(typeof time === 'string' ? Number(time) : time)
        if (price && observedAt) out[s] = { price, observedAt }
      }
      if (failed && Object.keys(out).length === 0) throw failed
      return out
    },
  })
}

export const kucoin = exchange(
  'kucoin',
  (id) => `https://api.kucoin.com/api/v1/market/stats?symbol=${encodeURIComponent(id)}`,
  (b) => ({ price: at(b, 'data.last'), time: at(b, 'data.time') }),
)

export const binance = exchange(
  'binance',
  (id) => `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(id)}`,
  (b) => ({ price: at(b, 'lastPrice'), time: at(b, 'closeTime') }),
)

/**
 * Bybit spot: the last trade with its own time (`/v5/market/recent-trade`), so a quiet pair ages
 * like it does on the market instead of looking fresh at every response.
 */
export const bybit = exchange(
  'bybit',
  (id) =>
    `https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=${encodeURIComponent(id)}&limit=1`,
  (b) => ({ price: at(b, 'result.list.0.price'), time: at(b, 'result.list.0.time') }),
)

export function coinpaprika(ids: Ids, fetchImpl?: typeof fetch): PriceSource {
  return {
    name: 'coinpaprika',
    async fetch(slots) {
      const out: SlotQuotes = {}
      let failed: unknown = null
      for (const s of slots) {
        const id = ids[s]
        if (!id) continue
        // One wrong or delisted id does not kill the quotes of the other instruments
        const body = (await getJson(
          `https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(id)}`,
          fetchImpl,
        ).catch((e: unknown) => {
          failed = e
          return null
        })) as {
          last_updated?: string
          quotes?: { USD?: { price?: number } }
        } | null
        if (!body) continue
        const price =
          body.quotes?.USD?.price === undefined ? null : normalizePrice(body.quotes.USD.price)
        if (price && body.last_updated)
          out[s] = { price, observedAt: new Date(body.last_updated).toISOString() }
      }
      // Not a single quote: the source is down; the oracle counts source failures (B-7)
      if (failed && Object.keys(out).length === 0) throw failed
      return out
    },
  }
}

const at = (v: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], v)

/** Quote time: ISO string or unix time (seconds or milliseconds). */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v))
    return new Date(v > 1e12 ? v : v * 1000).toISOString()
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  return null
}

/** HTTP source from config: URL with {id}, paths to the price and the time in the response JSON. */
export function httpJsonSource(
  spec: { name: string; url: string; ids: Ids; pricePath: string; timePath: string },
  fetchImpl?: typeof fetch,
): PriceSource {
  return {
    name: spec.name,
    async fetch(slots) {
      const out: SlotQuotes = {}
      for (const s of slots) {
        const id = spec.ids[s]
        if (!id) continue
        const body = await getJson(spec.url.replace('{id}', encodeURIComponent(id)), fetchImpl)
        const raw = at(body, spec.pricePath)
        const price =
          typeof raw === 'number'
            ? normalizePrice(raw)
            : typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw) && Number(raw) > 0
              ? raw
              : null
        const observedAt = toIso(at(body, spec.timePath))
        if (price && observedAt) out[s] = { price, observedAt }
      }
      return out
    },
  }
}

/**
 * Live oracle sources from ORACLE_SOURCES (B-7): each has its own instruments. An HTTP source
 * not named in ORACLE_SOURCES is used for its ids only with a shared list for all
 * instruments (the old format `coingecko,coinpaprika`).
 */
export function buildPriceSources(
  c: Pick<
    Config,
    | 'ORACLE_SOURCES'
    | 'ORACLE_HTTP_SOURCES'
    | 'COINGECKO_IDS'
    | 'COINPAPRIKA_IDS'
    | 'KUCOIN_IDS'
    | 'BINANCE_IDS'
    | 'BYBIT_IDS'
  > &
    Partial<
      Pick<
        Config,
        | 'REDSTONE_API_KEY'
        | 'REDSTONE_API_URL'
        | 'REDSTONE_IDS'
        | 'KAIKO_API_KEY'
        | 'KAIKO_API_URL'
        | 'KAIKO_IDS'
        | 'CHAINLINK_STREAMS_API_KEY'
        | 'CHAINLINK_STREAMS_API_SECRET'
        | 'CHAINLINK_STREAMS_URL'
        | 'CHAINLINK_FEED_IDS'
      >
    >,
): PriceSource[] {
  // Keyed sources (seam 2): absent without a key; a name in ORACLE_SOURCES is rejected by
  // loadConfig
  const keyed = (name: string): PriceSource | null =>
    name === 'redstone' && c.REDSTONE_API_KEY
      ? redstone(c.REDSTONE_IDS ?? {}, {
          url: c.REDSTONE_API_URL ?? 'https://api.redstone.finance',
          apiKey: c.REDSTONE_API_KEY,
        })
      : name === 'kaiko' && c.KAIKO_API_KEY
        ? kaiko(c.KAIKO_IDS ?? {}, {
            url: c.KAIKO_API_URL ?? 'https://us.market-api.kaiko.io',
            apiKey: c.KAIKO_API_KEY,
          })
        : name === 'chainlink' && c.CHAINLINK_STREAMS_API_KEY && c.CHAINLINK_STREAMS_API_SECRET
          ? chainlink(c.CHAINLINK_FEED_IDS ?? {}, {
              url: c.CHAINLINK_STREAMS_URL ?? 'https://api.dataengine.chain.link',
              apiKey: c.CHAINLINK_STREAMS_API_KEY,
              secret: c.CHAINLINK_STREAMS_API_SECRET,
            })
          : null
  const slotsOf = new Map<string, InstrumentSlot[]>()
  for (const slot of INSTRUMENT_SLOTS)
    for (const name of c.ORACLE_SOURCES[slot])
      slotsOf.set(name, [...(slotsOf.get(name) ?? []), slot])
  const lists = INSTRUMENT_SLOTS.map((slot) => c.ORACLE_SOURCES[slot].join(','))
  const shared = lists.every((l) => l === lists[0])
  const out: PriceSource[] = []
  for (const [name, slots] of slotsOf) {
    const spec = c.ORACLE_HTTP_SOURCES.find((h) => h.name === name)
    const base =
      name === 'coingecko'
        ? coingecko(c.COINGECKO_IDS)
        : name === 'coinpaprika'
          ? coinpaprika(c.COINPAPRIKA_IDS)
          : name === 'kucoin'
            ? kucoin(c.KUCOIN_IDS)
            : name === 'binance'
              ? binance(c.BINANCE_IDS)
              : name === 'bybit'
                ? bybit(c.BYBIT_IDS)
                : spec
                  ? httpJsonSource(spec)
                  : keyed(name)
    if (!base)
      throw new Error(`unknown ORACLE_SOURCES entry ${name}: add it to ORACLE_HTTP_SOURCES`)
    out.push({ ...base, slots })
  }
  if (shared)
    for (const spec of c.ORACLE_HTTP_SOURCES)
      if (!slotsOf.has(spec.name))
        out.push({
          ...httpJsonSource(spec),
          slots: INSTRUMENT_SLOTS.filter((slot) => spec.ids[slot]),
        })
  return out
}

/** USDC id at the built-in sources: this is how they quote USDCx by default. */
const USDC_IDS: Record<string, RegExp> = {
  coingecko: /^usd-coin$/,
  coinpaprika: /^usdc-usd-coin$/,
  kucoin: /^USDC-/,
  binance: /^USDC/,
  bybit: /^USDC/,
}

/**
 * B-7: USDCx has no public feed of its own. true means all USDCx sources actually quote USDC,
 * and the oracle will not see a USDCx depeg from USDC (metric oracle_usdcx_proxy_source).
 */
export function usdcxQuotedAsUsdc(
  c: Pick<
    Config,
    | 'ORACLE_SOURCES'
    | 'COINGECKO_IDS'
    | 'COINPAPRIKA_IDS'
    | 'KUCOIN_IDS'
    | 'BINANCE_IDS'
    | 'BYBIT_IDS'
  >,
): boolean {
  const ids: Record<string, string | undefined> = {
    coingecko: c.COINGECKO_IDS.usdcx,
    coinpaprika: c.COINPAPRIKA_IDS.usdcx,
    kucoin: c.KUCOIN_IDS.usdcx,
    binance: c.BINANCE_IDS.usdcx,
    bybit: c.BYBIT_IDS.usdcx,
  }
  return c.ORACLE_SOURCES.usdcx.every((name) => {
    const re = USDC_IDS[name]
    return !!re && re.test(ids[name] ?? '')
  })
}
