/**
 * Price sources keyed by API key (seam 2): RedStone, Kaiko, Chainlink Data Streams. Each
 * is enabled only with a key in env and only if named in ORACLE_SOURCES; without a key
 * loadConfig does not start (config.ts, KEYED_SOURCES). Keys are secrets: they never go into URLs
 * or logs, only into headers.
 *
 * TODO(config): response formats are taken from public API descriptions and not verified with a
 * live request (no keys): check against a provider response before enabling on a network.
 * - RedStone: GET {url}/prices?symbols=A,B&provider=redstone-primary-prod → {A:{value,timestamp}}
 * - Kaiko: GET {url}/v2/data/trades.v1/spot_direct_exchange_rate/{base}/usd/recent → data[0]
 * - Chainlink: GET {url}/api/v1/reports/latest?feedID=… (HMAC), fullReport → V3 report
 */
import { createHash, createHmac } from 'node:crypto'
import { decodeAbiParameters, type Hex } from 'viem'
import { fromUnits } from '../assets/profiles.ts'
import type { InstrumentSlot } from '../config.ts'
import { normalizePrice, type PriceSource, type SlotQuotes } from './prices.ts'

type Ids = Partial<Record<InstrumentSlot, string>>

const decimalString = (v: unknown): string | null =>
  typeof v === 'number'
    ? normalizePrice(v)
    : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0
      ? v
      : null
const iso = (t: unknown): string | null => {
  const n = typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t
  if (typeof n === 'number' && Number.isFinite(n))
    return new Date(n > 1e12 ? n : n * 1000).toISOString()
  if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString()
  return null
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  name: string,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return res.json()
}

export function redstone(
  ids: Ids,
  opts: { url: string; apiKey: string; fetchImpl?: typeof fetch },
): PriceSource {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a))
  return {
    name: 'redstone',
    async fetch(slots) {
      const wanted = slots.filter((s) => ids[s])
      if (!wanted.length) return {}
      const symbols = wanted.map((s) => encodeURIComponent(ids[s]!)).join(',')
      const body = (await getJson(
        `${opts.url.replace(/\/$/, '')}/prices?symbols=${symbols}&provider=redstone-primary-prod`,
        { 'x-api-key': opts.apiKey },
        doFetch,
        'redstone',
      )) as Record<string, { value?: unknown; timestamp?: unknown } | undefined>
      const out: SlotQuotes = {}
      for (const s of wanted) {
        const row = body[ids[s]!]
        const price = decimalString(row?.value)
        const observedAt = iso(row?.timestamp)
        if (price && observedAt) out[s] = { price, observedAt }
      }
      return out
    },
  }
}

export function kaiko(
  ids: Ids,
  opts: { url: string; apiKey: string; fetchImpl?: typeof fetch },
): PriceSource {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a))
  return {
    name: 'kaiko',
    async fetch(slots) {
      const out: SlotQuotes = {}
      let failed: unknown = null
      for (const s of slots) {
        const base = ids[s]
        if (!base) continue
        const body = (await getJson(
          `${opts.url.replace(/\/$/, '')}/v2/data/trades.v1/spot_direct_exchange_rate/${encodeURIComponent(base)}/usd/recent?interval=1m&page_size=1`,
          { 'x-api-key': opts.apiKey, accept: 'application/json' },
          doFetch,
          'kaiko',
        ).catch((e: unknown) => {
          failed = e
          return null
        })) as { data?: { price?: unknown; timestamp?: unknown }[] } | null
        const row = body?.data?.[0]
        const price = decimalString(row?.price)
        const observedAt = iso(row?.timestamp)
        if (price && observedAt) out[s] = { price, observedAt }
      }
      if (failed && Object.keys(out).length === 0) throw failed
      return out
    },
  }
}

/** Data Streams request signature: HMAC-SHA256 of `METHOD path sha256(body) key timestamp`. */
export function chainlinkHeaders(
  method: string,
  pathWithQuery: string,
  body: string,
  apiKey: string,
  secret: string,
  timestamp: number,
): Record<string, string> {
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const signature = createHmac('sha256', secret)
    .update(`${method} ${pathWithQuery} ${bodyHash} ${apiKey} ${timestamp}`)
    .digest('hex')
  return {
    authorization: apiKey,
    'x-authorization-timestamp': String(timestamp),
    'x-authorization-signature-sha256': signature,
  }
}

/** Data Streams fullReport → V3 report price (benchmarkPrice, 18 decimals) and observation time. */
export function decodeChainlinkReport(fullReport: Hex): { price: string; observedAt: string } {
  const [, reportBlob] = decodeAbiParameters(
    [
      { type: 'bytes32[3]' },
      { type: 'bytes' },
      { type: 'bytes32[]' },
      { type: 'bytes32[]' },
      { type: 'bytes32' },
    ],
    fullReport,
  )
  const v3 = decodeAbiParameters(
    [
      { type: 'bytes32', name: 'feedId' },
      { type: 'uint32', name: 'validFromTimestamp' },
      { type: 'uint32', name: 'observationsTimestamp' },
      { type: 'uint192', name: 'nativeFee' },
      { type: 'uint192', name: 'linkFee' },
      { type: 'uint32', name: 'expiresAt' },
      { type: 'int192', name: 'benchmarkPrice' },
      { type: 'int192', name: 'bid' },
      { type: 'int192', name: 'ask' },
    ],
    reportBlob,
  )
  const price = v3[6]
  if (price <= 0n) throw new Error('chainlink: non-positive benchmark price')
  return {
    price: fromUnits(price, 18),
    observedAt: new Date(Number(v3[2]) * 1000).toISOString(),
  }
}

export function chainlink(
  feeds: Ids,
  opts: {
    url: string
    apiKey: string
    secret: string
    fetchImpl?: typeof fetch
    now?: () => number
  },
): PriceSource {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a))
  const now = opts.now ?? Date.now
  return {
    name: 'chainlink',
    async fetch(slots) {
      const out: SlotQuotes = {}
      let failed: unknown = null
      for (const s of slots) {
        const feedId = feeds[s]
        if (!feedId) continue
        const path = `/api/v1/reports/latest?feedID=${feedId}`
        try {
          const body = (await getJson(
            `${opts.url.replace(/\/$/, '')}${path}`,
            chainlinkHeaders('GET', path, '', opts.apiKey, opts.secret, now()),
            doFetch,
            'chainlink',
          )) as { report?: { fullReport?: string } }
          const full = body.report?.fullReport
          if (!full?.startsWith('0x')) continue
          out[s] = decodeChainlinkReport(full as Hex)
        } catch (e) {
          failed = e
        }
      }
      if (failed && Object.keys(out).length === 0) throw failed
      return out
    },
  }
}
