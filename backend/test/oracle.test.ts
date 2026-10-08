import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  agreeingQuotes,
  createOracle,
  decidePublish,
  preferFresh,
  selectQuotes,
} from '../src/bots/oracle.ts'
import {
  DemoPrices,
  httpJsonSource,
  type PriceSource,
  type SlotQuotes,
} from '../src/bots/prices.ts'
import { loadConfig } from '../src/config.ts'
import type { Deployment } from '../src/deployment.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { createMetrics } from '../src/metrics.ts'
import { dec } from '../src/protocol/math.ts'

const T0 = Date.parse('2026-10-01T12:00:00Z')
const iso = (t: number) => new Date(t).toISOString()
// CC on TestNet is Amulet: the instrument id differs from the symbol (A-4)
const d = {
  oracle: 'oracle::1',
  usdcx: { admin: 'circle::1', id: 'USDCx' },
  cc: { admin: 'DSO::1', id: 'Amulet' },
  cbtc: { admin: 'bitsafe::1', id: 'CBTC' },
} as Deployment

function logger() {
  const lines: { level: string; msg: string; obj: Record<string, unknown> }[] = []
  const at = (level: string) => (obj: Record<string, unknown>, msg?: string) =>
    lines.push({ level, msg: msg ?? String(obj), obj: typeof obj === 'object' ? obj : {} })
  return {
    log: { info: at('info'), warn: at('warn'), error: at('error') } as unknown as FastifyBaseLogger,
    lines,
  }
}

const source = (name: string, quotes: () => SlotQuotes): PriceSource => ({
  name,
  fetch: async () => quotes(),
})

function ledgerWith(prices: Record<string, { price: string; at: number }>) {
  const submitted: { cid: string; quotes: { source: string; price: string }[] }[] = []
  const feeds = Object.entries({ usdcx: d.usdcx, cc: d.cc, cbtc: d.cbtc }).map(([slot, i]) => ({
    contractId: `feed-${slot}`,
    payload: {
      oracle: d.oracle,
      instrumentId: i,
      observers: [],
      quotes: prices[slot]
        ? [
            { source: 'a', price: prices[slot]!.price, observedAt: iso(prices[slot]!.at) },
            { source: 'b', price: prices[slot]!.price, observedAt: iso(prices[slot]!.at) },
          ]
        : [],
    },
  }))
  const ledger = {
    query: async () => feeds,
    submit: async (
      _a: string[],
      cmds: { ExerciseCommand: { contractId: string; choiceArgument: { newQuotes: never } } }[],
    ) => {
      for (const c of cmds)
        submitted.push({
          cid: c.ExerciseCommand.contractId,
          quotes: c.ExerciseCommand.choiceArgument.newQuotes,
        })
      return { updateId: 'u', events: [] }
    },
  } as unknown as LedgerClient
  return { ledger, submitted }
}

const all = (price: Record<string, string>, at = T0) =>
  Object.fromEntries(
    Object.entries(price).map(([k, p]) => [k, { price: p, observedAt: iso(at) }]),
  ) as SlotQuotes

describe('fresh quotes first (review 08.10, item 1)', () => {
  const t = Date.parse('2026-10-08T07:00:00Z')
  const at = (sec: number) => new Date(t - sec * 1000).toISOString()
  it('a lagging source is left out while two fresh ones remain', () => {
    const q = [
      { source: 'coingecko', observedAt: at(200) },
      { source: 'kucoin', observedAt: at(1) },
      { source: 'bybit', observedAt: at(2) },
    ]
    expect(preferFresh(q, 2, t, 120_000).map((x) => x.source)).toEqual(['kucoin', 'bybit'])
  })
  it('on the edge: exactly freshMs old is fresh, one ms more is not', () => {
    const edge = [
      { source: 'a', observedAt: new Date(t - 120_000).toISOString() },
      { source: 'b', observedAt: at(0) },
      { source: 'c', observedAt: new Date(t - 120_001).toISOString() },
    ]
    expect(preferFresh(edge, 2, t, 120_000).map((x) => x.source)).toEqual(['a', 'b'])
  })
  it('with fewer fresh ones than needed, all agreeing quotes stay', () => {
    const q = [
      { source: 'coingecko', observedAt: at(200) },
      { source: 'kucoin', observedAt: at(1) },
    ]
    expect(preferFresh(q, 2, t, 120_000)).toEqual(q)
  })
})

describe('quote selection: strict before fallback, fresh before all (review 08.10, item 1)', () => {
  const t = Date.parse('2026-10-08T07:00:00Z')
  const at = (sec: number) => new Date(t - sec * 1000).toISOString()
  const opts = {
    minSources: 2,
    maxSourceDeviation: '0.03',
    fallbackSourceDeviation: '0.15',
    freshQuoteMs: 120_000,
  }
  it('a lagging quote that agrees does not push out a fresh one', () => {
    // the median is CoinGecko's 100: KuCoin + CoinGecko agree, Bybit is 3.5 % off it, but
    // KuCoin + Bybit agree within 3 % on their own and are both fresh
    const q = [
      { source: 'coingecko', price: '100', observedAt: at(200) },
      { source: 'kucoin', price: '101', observedAt: at(1) },
      { source: 'bybit', price: '103.5', observedAt: at(2) },
    ]
    const r = selectQuotes(q, opts, t)
    expect(r.strict).toBe(true)
    expect(r.quotes.map((x) => x.source).sort()).toEqual(['bybit', 'kucoin'])
  })
  it('strict among all beats fallback among the fresh: borrowing stays open', () => {
    const q = [
      { source: 'coingecko', price: '100', observedAt: at(200) },
      { source: 'kucoin', price: '101', observedAt: at(1) },
      { source: 'bybit', price: '110', observedAt: at(2) },
    ]
    const r = selectQuotes(q, opts, t)
    expect(r.strict).toBe(true)
    expect(r.quotes.map((x) => x.source).sort()).toEqual(['coingecko', 'kucoin'])
  })
  it('no strict group anywhere: the fallback, still not strict', () => {
    const q = [
      { source: 'kucoin', price: '100', observedAt: at(1) },
      { source: 'bybit', price: '110', observedAt: at(2) },
    ]
    expect(selectQuotes(q, opts, t)).toEqual({ quotes: q, strict: false })
  })
})

describe('agreeing quotes (A-22)', () => {
  it('defaults: strict 3 % to publish, 15 % only as a fallback (review 03.10, item 12)', () => {
    const c = loadConfig({})
    expect(c.ORACLE_MAX_SOURCE_DEVIATION).toBe('0.03')
    expect(c.ORACLE_FALLBACK_SOURCE_DEVIATION).toBe('0.15')
  })
  it('drops an outlier and keeps the group within the contract deviation', () => {
    const q = [
      { source: 'a', price: '100' },
      { source: 'b', price: '101' },
      { source: 'c', price: '150' },
    ]
    expect(
      agreeingQuotes(q, '0.03')
        .map((x) => x.source)
        .sort(),
    ).toEqual(['a', 'b'])
  })
  it('keeps the spread (max − min) / min under the limit, not just distance to the median', () => {
    const q = [
      { source: 'a', price: '97.5' },
      { source: 'b', price: '100' },
      { source: 'c', price: '102.5' },
    ]
    const kept = agreeingQuotes(q, '0.03')
    const ps = kept.map((x) => dec(x.price))
    const lo = ps.reduce((a, b) => (a.lt(b) ? a : b))
    const hi = ps.reduce((a, b) => (a.gt(b) ? a : b))
    expect(hi.minus(lo).div(lo).lte('0.03')).toBe(true)
    expect(kept).toHaveLength(2)
  })
})

describe('publish decision (B-7)', () => {
  const opts = {
    publishDeviation: '0.005',
    heartbeatMs: 240_000,
    maxStep: '0.2',
    stepConfirmations: 3,
  }
  const cur = { median: dec('100'), oldestObservedAt: T0 }
  it('skips an unchanged price before the heartbeat', () => {
    expect(
      decidePublish({
        current: cur,
        next: { median: dec('100.4'), oldestObservedAt: T0 + 30_000 },
        now: T0 + 30_000,
        pendingJumps: 0,
        opts,
      }),
    ).toEqual({ publish: false, reason: 'unchanged' })
  })
  it('publishes on a change at the threshold', () => {
    expect(
      decidePublish({
        current: cur,
        next: { median: dec('100.5'), oldestObservedAt: T0 },
        now: T0,
        pendingJumps: 0,
        opts,
      }).reason,
    ).toBe('deviation')
  })
  it('publishes on the heartbeat only with newer quotes', () => {
    const late = T0 + 240_000
    expect(
      decidePublish({
        current: cur,
        next: { median: dec('100'), oldestObservedAt: late - 10_000 },
        now: late,
        pendingJumps: 0,
        opts,
      }).reason,
    ).toBe('heartbeat')
    expect(
      decidePublish({
        current: cur,
        next: { median: dec('100'), oldestObservedAt: T0 },
        now: late,
        pendingJumps: 0,
        opts,
      }).reason,
    ).toBe('unchanged')
  })
  it('holds a jump above maxStep until it repeats stepConfirmations times', () => {
    const next = { median: dec('70'), oldestObservedAt: T0 }
    expect(decidePublish({ current: cur, next, now: T0, pendingJumps: 0, opts }).reason).toBe(
      'jump-held',
    )
    expect(decidePublish({ current: cur, next, now: T0, pendingJumps: 1, opts }).reason).toBe(
      'jump-held',
    )
    expect(decidePublish({ current: cur, next, now: T0, pendingJumps: 2, opts }).reason).toBe(
      'confirmed-jump',
    )
    // exactly at the step limit: a normal publication
    expect(
      decidePublish({
        current: cur,
        next: { median: dec('80'), oldestObservedAt: T0 },
        now: T0,
        pendingJumps: 0,
        opts,
      }).reason,
    ).toBe('deviation')
  })
})

describe('oracle bot (A-4, B-7, A-22)', () => {
  const fresh = {
    usdcx: { price: '1', at: T0 - 60_000 },
    cc: { price: '0.24', at: T0 - 60_000 },
    cbtc: { price: '100000', at: T0 - 60_000 },
  }

  it('finds the Amulet feed by InstrumentId and quotes by slot, not by symbol', async () => {
    const { ledger, submitted } = ledgerWith(fresh)
    const { log } = logger()
    const s = all({ usdcx: '1', cc: '0.25', cbtc: '100000' })
    const publish = createOracle(
      ledger,
      d,
      [source('x', () => s), source('y', () => s)],
      log,
      {},
      undefined,
      () => T0,
    )
    expect(await publish()).toEqual(['cc'])
    expect(submitted.map((x) => x.cid)).toEqual(['feed-cc'])
  })

  it('publishes with 2 of 3 sources when one is down or off', async () => {
    const { ledger, submitted } = ledgerWith(fresh)
    const { log } = logger()
    const publish = createOracle(
      ledger,
      d,
      [
        source('a', () => all({ cc: '0.25' })),
        source('b', () => {
          throw new Error('down')
        }),
        source('c', () => all({ cc: '0.2505' })),
        source('d', () => all({ cc: '0.9' })),
      ],
      log,
      {},
      undefined,
      () => T0,
    )
    await publish()
    expect(submitted[0]!.quotes.map((q) => q.source).sort()).toEqual(['a', 'c'])
  })

  it('a lone bad source among three stays out; two sources 10 % apart still publish', async () => {
    // review 03.10 follow-up: 100 / 100.5 agree strictly, 90 is dropped (it would trigger absorbs)
    {
      const { ledger, submitted } = ledgerWith(fresh)
      const { log } = logger()
      await createOracle(
        ledger,
        d,
        [
          source('a', () => all({ cc: '0.25' })),
          source('b', () => all({ cc: '0.25125' })),
          source('c', () => all({ cc: '0.225' })),
        ],
        log,
        { fallbackSourceDeviation: '0.15' },
        undefined,
        () => T0,
      )()
      expect(submitted[0]!.quotes.map((q) => q.source).sort()).toEqual(['a', 'b'])
    }
    // no strict pair: the wide group is published so liquidations keep a fresh price
    {
      const { ledger, submitted } = ledgerWith(fresh)
      const { log } = logger()
      await createOracle(
        ledger,
        d,
        [source('a', () => all({ cc: '0.25' })), source('b', () => all({ cc: '0.275' }))],
        log,
        { fallbackSourceDeviation: '0.15' },
        undefined,
        () => T0,
      )()
      expect(submitted[0]!.quotes.map((q) => q.source).sort()).toEqual(['a', 'b'])
    }
  })

  it('drops quotes outside the sanity bounds, stale or from the future', async () => {
    const { ledger, submitted } = ledgerWith({ cc: { price: '0.2', at: T0 - 250_000 } })
    const { log, lines } = logger()
    const publish = createOracle(
      ledger,
      d,
      [
        source('a', () => all({ cc: '0.21' })),
        source('b', () => all({ cc: '5000' })), // out of bounds
        source('c', () => all({ cc: '0.21' }, T0 - 300_000)), // older than maxQuoteAgeMs
        source('e', () => all({ cc: '0.21' }, T0 + 120_000)), // from the future
      ],
      log,
      { bounds: { cc: { min: '0.0001', max: '100' } }, staleCycles: 1 },
      undefined,
      () => T0,
    )
    await publish()
    expect(submitted).toHaveLength(0)
    expect(lines.filter((l) => l.msg === 'quote dropped').map((l) => l.obj.why)).toEqual(
      expect.arrayContaining(['out of bounds', 'stale', 'from the future']),
    )
    // one agreeing source is not enough and the ledger price is stale: alert
    expect(
      lines.some((l) => l.level === 'error' && l.msg === 'price not published for N cycles'),
    ).toBe(true)
  })

  it('a crash is published only after it is confirmed; metrics show the missed cycles', async () => {
    const { ledger, submitted } = ledgerWith(fresh)
    const { log } = logger()
    const metrics = createMetrics()
    const s = all({ usdcx: '1', cc: '0.24', cbtc: '50000' })
    const publish = createOracle(
      ledger,
      d,
      [source('x', () => s), source('y', () => s)],
      log,
      { stepConfirmations: 3 },
      metrics,
      () => T0,
    )
    await publish()
    await publish()
    expect(submitted).toHaveLength(0)
    expect(metrics.get('oracle_missed_cycles', { instrument: 'cbtc' })).toBe(2)
    await publish()
    expect(submitted.map((x) => x.cid)).toEqual(['feed-cbtc'])
    expect(metrics.get('oracle_missed_cycles', { instrument: 'cbtc' })).toBe(0)
    expect(metrics.render()).toMatch(/oracle_price_age_seconds\{instrument="cbtc"\}/)
  })

  it('demo: forced publish skips the thresholds', async () => {
    const { ledger, submitted } = ledgerWith(fresh)
    const demo = new DemoPrices({ USDCx: '1', CC: '0.2', CBTC: '100000' })
    const publish = createOracle(
      ledger,
      d,
      demo.sources(),
      logger().log,
      { maxStep: null },
      undefined,
      () => Date.now(),
    )
    await publish({ force: true })
    expect(submitted.map((x) => x.cid).sort()).toEqual(['feed-cbtc', 'feed-cc', 'feed-usdcx'])
  })
})

describe('stale on-ledger price (deployProd bootstrap, oracle outage)', () => {
  it('publishes a big move at once when the ledger price is already stale', () => {
    const opts = {
      publishDeviation: '0.005',
      heartbeatMs: 240_000,
      maxStep: '0.2',
      stepConfirmations: 3,
      staleAfterMs: 300_000,
    }
    const current = { median: dec('1'), oldestObservedAt: T0 - 400_000 }
    expect(
      decidePublish({
        current,
        next: { median: dec('0.25'), oldestObservedAt: T0 },
        now: T0,
        pendingJumps: 0,
        opts,
      }).reason,
    ).toBe('no-price')
  })
})

describe('HTTP price source', () => {
  it('reads price and time by path; refuses a quote without a time', async () => {
    const bodies: Record<string, unknown> = {
      'canton-coin': { data: { price: '0.2512', ts: 1790000000 } },
      btc: { data: { price: 100000.5 } },
    }
    const fetchImpl = (async (url: string) =>
      new Response(JSON.stringify(bodies[url.split('/').pop()!]))) as unknown as typeof fetch
    const src = httpJsonSource(
      {
        name: 'x',
        url: 'https://x.example/{id}',
        ids: { cc: 'canton-coin', cbtc: 'btc' },
        pricePath: 'data.price',
        timePath: 'data.ts',
      },
      fetchImpl,
    )
    expect(await src.fetch(['cc', 'cbtc'])).toEqual({
      cc: { price: '0.2512', observedAt: new Date(1790000000 * 1000).toISOString() },
    })
  })
})
