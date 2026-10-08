/**
 * Oracle publisher (T3.1.3, B-7, A-4, A-22).
 *
 * - Instruments are addressed by deployment.json slot and full InstrumentId (A-4): the feed is
 *   looked up by admin and id, source quotes by slot. Amulet with id "Amulet" is found.
 * - N of M sources (A-22): quotes outside sanity bounds, stale ones and ones from the future
 *   are dropped; of the rest, the most agreeing group around the median with a spread of at most
 *   maxSourceDeviation is taken (as the contract will check). Fewer than minSources: no publish.
 * - Publish on change or heartbeat (B-7.4): the median moved more than publishDeviation from
 *   the ledger price, or the ledger quotes are older than heartbeat and the sources have newer
 *   ones.
 * - A jump larger than maxStep is published only after stepConfirmations cycles in a row
 *   (circuit breaker, B-7.2): an outlier of low-liquidity CC does not trigger liquidations at once.
 * - Metrics for price age and missed cycles; after staleCycles, error (B-7.5, B-10).
 */
import type { FastifyBaseLogger } from 'fastify'
import { INSTRUMENT_SLOTS, type InstrumentSlot } from '../config.ts'
import type { Deployment } from '../deployment.ts'
import type { LedgerClient } from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import type { Metrics } from '../metrics.ts'
import { type Dec, dec } from '../protocol/math.ts'
import { type PriceFeedPayload, type PriceQuote, sameInstrument } from '../protocol/types.ts'
import type { PriceSource, SourceQuote } from './prices.ts'

export interface OracleOptions {
  minSources: number
  /** The sources must agree within this to publish (contract: maxSourceDeviation for borrows) */
  maxSourceDeviation: string
  /**
   * Only when no group of minSources agrees within maxSourceDeviation: the widest spread that is
   * still published (contract: maxLiquidationSourceDeviation), so liquidations keep a fresh feed
   * while borrows close on the contract's own check. A single bad source among three never gets in:
   * the other two agree strictly (review 03.10, item 12 and its follow-up)
   */
  fallbackSourceDeviation: string
  publishDeviation: string
  heartbeatMs: number
  /** null: no circuit breaker (demo: a human changes the price) */
  maxStep: string | null
  stepConfirmations: number
  bounds: Partial<Record<InstrumentSlot, { min: string; max: string }>>
  staleCycles: number
  /** An older quote is unusable (contract: maxPriceAgeSeconds = 300) */
  maxQuoteAgeMs: number
  /**
   * With more agreeing quotes than minSources, the ones older than this are left out of the
   * publish: the feed is as old as its oldest quote, so a lagging source would make it stale soon
   */
  freshQuoteMs: number
  /** A quote further in the future is unusable (maxClockSkewSeconds) */
  maxSkewMs: number
  /** B-7: USDCx median further than this fraction from 1 raises an alert; null: no check */
  usdcxDepegBound: string | null
}

export const defaultOracleOptions: OracleOptions = {
  minSources: 2,
  maxSourceDeviation: '0.03',
  fallbackSourceDeviation: '0.15',
  publishDeviation: '0.005',
  heartbeatMs: 240_000,
  maxStep: '0.2',
  stepConfirmations: 3,
  bounds: {},
  staleCycles: 5,
  maxQuoteAgeMs: 240_000,
  freshQuoteMs: 120_000,
  maxSkewMs: 30_000,
  usdcxDepegBound: null,
}

const median = (xs: Dec[]): Dec => {
  const s = [...xs].sort((a, b) => a.cmp(b))
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : s[m - 1]!.plus(s[m]!).div(2)
}

/**
 * Agreeing quotes: the closest to the median while the spread (max − min) / min is at most
 * `maxDeviation`. A pure function, covered by a unit test.
 */
export function agreeingQuotes<Q extends { price: string }>(
  quotes: Q[],
  maxDeviation: string,
): Q[] {
  if (quotes.length === 0) return []
  const m = median(quotes.map((q) => dec(q.price)))
  const byDistance = [...quotes].sort((a, b) =>
    dec(a.price).minus(m).abs().cmp(dec(b.price).minus(m).abs()),
  )
  const picked: Q[] = []
  let lo: Dec | null = null
  let hi: Dec | null = null
  for (const q of byDistance) {
    const p = dec(q.price)
    const nlo: Dec = lo === null || p.lt(lo) ? p : lo
    const nhi: Dec = hi === null || p.gt(hi) ? p : hi
    if (nhi.minus(nlo).div(nlo).gt(maxDeviation)) continue
    picked.push(q)
    lo = nlo
    hi = nhi
  }
  return picked
}

/**
 * The contract checks the age of every quote, so a feed is stale as soon as its oldest quote is
 * (review 08.10, item 1: CC went stale while CoinGecko lagged minutes behind the exchanges). With
 * at least `minSources` quotes newer than `freshMs`, only those are published; otherwise all are.
 * Dropping agreeing quotes only narrows the spread, so the deviation check still holds.
 */
export function preferFresh<Q extends { observedAt: string }>(
  quotes: Q[],
  minSources: number,
  now: number,
  freshMs: number,
): Q[] {
  const fresh = quotes.filter((q) => now - new Date(q.observedAt).getTime() <= freshMs)
  return fresh.length >= minSources ? fresh : quotes
}

/**
 * Quotes to publish (A-22, review 08.10, item 1): the strict tolerance before the fallback one, and
 * within each the fresh quotes before all of them. So a lagging source that still agrees does not
 * push out a fresh one that agrees only with the others, and does not age the feed.
 * `strict`: the quotes agree within maxSourceDeviation (borrowing stays open).
 */
export function selectQuotes<Q extends { price: string; observedAt: string }>(
  candidates: Q[],
  opts: Pick<
    OracleOptions,
    'minSources' | 'maxSourceDeviation' | 'fallbackSourceDeviation' | 'freshQuoteMs'
  >,
  now: number,
): { quotes: Q[]; strict: boolean } {
  const fresh = preferFresh(candidates, opts.minSources, now, opts.freshQuoteMs)
  const pools = fresh.length < candidates.length ? [fresh, candidates] : [candidates]
  for (const [deviation, strict] of [
    [opts.maxSourceDeviation, true],
    [opts.fallbackSourceDeviation, false],
  ] as const)
    for (const pool of pools) {
      const agree = agreeingQuotes(pool, deviation)
      if (agree.length >= opts.minSources)
        return { quotes: preferFresh(agree, opts.minSources, now, opts.freshQuoteMs), strict }
    }
  return { quotes: agreeingQuotes(candidates, opts.fallbackSourceDeviation), strict: false }
}

export type PublishDecision =
  | { publish: true; reason: 'no-price' | 'deviation' | 'heartbeat' | 'confirmed-jump' | 'forced' }
  | { publish: false; reason: 'unchanged' | 'jump-held' }

/** Whether to publish a new median over the ledger price. */
export function decidePublish(input: {
  current: { median: Dec; oldestObservedAt: number } | null
  next: { median: Dec; oldestObservedAt: number }
  now: number
  pendingJumps: number
  opts: Pick<
    OracleOptions,
    'publishDeviation' | 'heartbeatMs' | 'maxStep' | 'stepConfirmations'
  > & {
    staleAfterMs?: number
  }
  force?: boolean
}): PublishDecision {
  const { current, next, now, opts } = input
  if (input.force) return { publish: true, reason: 'forced' }
  if (!current) return { publish: true, reason: 'no-price' }
  // The ledger price is already stale and permits nothing (deployment creates feeds stale,
  // oracle downtime): publish at once; the agreeing-sources filter still applies
  if (opts.staleAfterMs !== undefined && now - current.oldestObservedAt > opts.staleAfterMs)
    return { publish: true, reason: 'no-price' }
  const change = next.median.minus(current.median).abs().div(current.median)
  if (opts.maxStep !== null && change.gt(opts.maxStep)) {
    return input.pendingJumps + 1 >= opts.stepConfirmations
      ? { publish: true, reason: 'confirmed-jump' }
      : { publish: false, reason: 'jump-held' }
  }
  if (change.gte(opts.publishDeviation)) return { publish: true, reason: 'deviation' }
  if (
    now - current.oldestObservedAt >= opts.heartbeatMs &&
    next.oldestObservedAt > current.oldestObservedAt
  )
    return { publish: true, reason: 'heartbeat' }
  return { publish: false, reason: 'unchanged' }
}

/**
 * Feed from deployProd (D-1): quotes bootstrap-a/bootstrap-b are stale by design, the price is a
 * placeholder. Publish over it at once and in full (PriceFeed_Update replaces the quote list),
 * without the circuit breaker: a jump from the placeholder to the market is not an outlier.
 */
export const isBootstrapFeed = (quotes: { source: string }[]) =>
  quotes.length > 0 && quotes.every((q) => q.source.startsWith('bootstrap-'))

const summarize = (quotes: { price: string; observedAt: string }[]) => ({
  median: median(quotes.map((q) => dec(q.price))),
  oldestObservedAt: Math.min(...quotes.map((q) => new Date(q.observedAt).getTime())),
})

export function createOracle(
  ledger: LedgerClient,
  d: Deployment,
  sources: PriceSource[],
  log: FastifyBaseLogger,
  options: Partial<OracleOptions> = {},
  metrics?: Metrics,
  now: () => number = Date.now,
) {
  const opts = { ...defaultOracleOptions, ...options }
  const failures = new Map<string, number>()
  /** A jump awaiting confirmation: how many cycles in a row */
  const pendingJumps = new Map<InstrumentSlot, number>()
  /** Cycles in a row when publishing was needed but did not happen */
  const missed = new Map<InstrumentSlot, number>()
  const lastPublishAt = new Map<InstrumentSlot, number>()

  const usable = (slot: InstrumentSlot, q: SourceQuote, t: number) => {
    const b = opts.bounds[slot]
    const p = dec(q.price)
    if (b && (p.lt(b.min) || p.gt(b.max))) return 'out of bounds'
    const age = t - new Date(q.observedAt).getTime()
    if (Number.isNaN(age)) return 'bad time'
    if (age > opts.maxQuoteAgeMs) return 'stale'
    if (-age > opts.maxSkewMs) return 'from the future'
    return null
  }

  const miss = (slot: InstrumentSlot, why: string, extra: Record<string, unknown> = {}) => {
    const n = (missed.get(slot) ?? 0) + 1
    missed.set(slot, n)
    metrics?.gauge('oracle_missed_cycles', 'cycles in a row without a needed price publish', n, {
      instrument: slot,
    })
    if (n >= opts.staleCycles)
      log.error({ instrument: slot, cycles: n, why, ...extra }, 'price not published for N cycles')
    else log.warn({ instrument: slot, why, ...extra }, 'price not published')
  }

  async function publish(run: { force?: boolean } = {}): Promise<InstrumentSlot[]> {
    const t = now()
    // B-7: a source is asked only about its instruments, extra quotes are not taken
    const deployed = INSTRUMENT_SLOTS.filter((slot) => !!d[slot])
    const slotsOf = (s: PriceSource) => (s.slots ?? deployed).filter((x) => deployed.includes(x))
    const results = await Promise.allSettled(sources.map((s) => s.fetch(slotsOf(s))))
    const bySource = results.flatMap((r, i) => {
      const source = sources[i]!
      if (r.status === 'fulfilled') {
        failures.set(source.name, 0)
        const allowed = new Set(slotsOf(source))
        const quotes = Object.fromEntries(
          Object.entries(r.value).filter(([slot]) => allowed.has(slot as InstrumentSlot)),
        ) as typeof r.value
        return [{ source: source.name, quotes }]
      }
      const n = (failures.get(source.name) ?? 0) + 1
      failures.set(source.name, n)
      metrics?.inc('oracle_source_failures_total', 'price source fetch failures', {
        source: source.name,
      })
      if (n >= 3)
        log.error({ source: source.name, err: String(r.reason) }, 'price source down for 3 cycles')
      return []
    })
    // Own feeds only: after an oracle rotation, others' feeds may remain in the ACS (§4, 0.4.0)
    const feeds = (
      await ledger.query<PriceFeedPayload>(d.oracle, { templateId: TEMPLATES.priceFeed })
    ).filter((f) => f.payload.oracle === d.oracle)
    const published: InstrumentSlot[] = []
    for (const slot of deployed) {
      const instrument = d[slot]!
      const feed = feeds.find((f) => sameInstrument(f.payload.instrumentId, instrument))
      if (feed?.payload.quotes.length) {
        const age = (t - summarize(feed.payload.quotes).oldestObservedAt) / 1000
        metrics?.gauge('oracle_price_age_seconds', 'age of the oldest on-ledger quote', age, {
          instrument: slot,
        })
      }
      const candidates: PriceQuote[] = []
      for (const s of bySource) {
        const q = s.quotes[slot]
        if (!q) continue
        const bad = usable(slot, q, t)
        if (bad) {
          log.warn(
            { instrument: slot, source: s.source, price: q.price, why: bad },
            'quote dropped',
          )
          continue
        }
        candidates.push({ source: s.source, price: q.price, observedAt: q.observedAt })
      }
      const { quotes, strict } = selectQuotes(candidates, opts, t)
      if (!strict && quotes.length >= opts.minSources)
        log.warn(
          { instrument: slot, sources: quotes.map((q) => q.source) },
          'sources disagree beyond the borrow tolerance: published for liquidations, borrowing closes',
        )
      if (slot === 'usdcx' && opts.usdcxDepegBound !== null && quotes.length >= opts.minSources) {
        const m = median(quotes.map((q) => dec(q.price)))
        const off = m.minus(1).abs().gt(opts.usdcxDepegBound)
        metrics?.gauge(
          'oracle_usdcx_depeg',
          '1 — the USDCx median is beyond ORACLE_USDCX_DEPEG_BOUND',
          off ? 1 : 0,
        )
        // The price is published: the contract closes borrowing on depeg (maxDebtDepeg), the alert
        // is for humans
        if (off)
          log.error(
            { instrument: slot, median: m.toString(), bound: opts.usdcxDepegBound },
            'USDCx depeg beyond ORACLE_USDCX_DEPEG_BOUND',
          )
      }
      if (!feed) {
        // New oracle after rotation (§4): no own feeds, create them once there is an agreeing
        // price. The observer is the operator; users get the feed via disclosure
        if (quotes.length < opts.minSources) {
          miss(slot, 'no own price feed and not enough agreeing sources')
          continue
        }
        try {
          await ledger.submit(
            [d.oracle],
            [
              {
                CreateCommand: {
                  templateId: TEMPLATES.priceFeed,
                  createArguments: {
                    oracle: d.oracle,
                    instrumentId: instrument,
                    quotes,
                    observers: [d.operator],
                  },
                },
              },
            ],
          )
          missed.set(slot, 0)
          lastPublishAt.set(slot, t)
          published.push(slot)
          metrics?.inc('oracle_publish_total', 'price feed updates', {
            instrument: slot,
            reason: 'created',
          })
          log.warn({ instrument: slot }, 'price feed created for this oracle')
        } catch (err) {
          miss(slot, 'feed create failed', { err: String(err) })
        }
        continue
      }
      // deployProd placeholder is treated like a feed without a price: publish at once (D-1, seam
      // 10)
      const current =
        feed.payload.quotes.length && !isBootstrapFeed(feed.payload.quotes)
          ? summarize(feed.payload.quotes)
          : null
      const due = !current || t - current.oldestObservedAt >= opts.heartbeatMs
      // Fewer than minSources agreeing sources: no publish; the contract requires two
      if (quotes.length < opts.minSources) {
        if (due)
          miss(slot, 'not enough agreeing sources', {
            sources: candidates.length,
            agreeing: quotes.length,
          })
        continue
      }
      const next = summarize(quotes)
      const decision = decidePublish({
        current,
        next,
        now: t,
        pendingJumps: pendingJumps.get(slot) ?? 0,
        // the contract's maxPriceAgeSeconds = 300 s; a quote older than maxQuoteAgeMs + margin is
        // dead
        opts: { ...opts, staleAfterMs: opts.maxQuoteAgeMs + 60_000 },
        ...(run.force ? { force: true } : {}),
      })
      if (!decision.publish) {
        if (decision.reason === 'jump-held') {
          pendingJumps.set(slot, (pendingJumps.get(slot) ?? 0) + 1)
          log.error(
            {
              instrument: slot,
              from: current?.median.toString(),
              to: next.median.toString(),
              confirmations: pendingJumps.get(slot),
            },
            'price jump held until confirmed',
          )
          miss(slot, 'price jump held')
        } else {
          pendingJumps.delete(slot)
          missed.set(slot, 0)
        }
        continue
      }
      // A failure of one instrument does not stop the others (audit S4)
      try {
        await ledger.submit(
          [d.oracle],
          [
            {
              ExerciseCommand: {
                templateId: TEMPLATES.priceFeed,
                contractId: feed.contractId,
                choice: 'PriceFeed_Update',
                choiceArgument: { newQuotes: quotes },
              },
            },
          ],
        )
        pendingJumps.delete(slot)
        missed.set(slot, 0)
        lastPublishAt.set(slot, t)
        published.push(slot)
        metrics?.inc('oracle_publish_total', 'price feed updates', {
          instrument: slot,
          reason: decision.reason,
        })
        metrics?.gauge(
          'oracle_missed_cycles',
          'cycles in a row without a needed price publish',
          0,
          {
            instrument: slot,
          },
        )
        metrics?.gauge(
          'oracle_price_age_seconds',
          'age of the oldest on-ledger quote',
          (t - next.oldestObservedAt) / 1000,
          { instrument: slot },
        )
      } catch (err) {
        miss(slot, 'publish failed', { err: String(err) })
      }
    }
    return published
  }

  return Object.assign(publish, {
    state: () => ({
      missed: Object.fromEntries(missed),
      lastPublishAt: Object.fromEntries(lastPublishAt),
    }),
  })
}

export type Oracle = ReturnType<typeof createOracle>
