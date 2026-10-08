import type { FastifyPluginAsync } from 'fastify'
import type { HealthResponse, ReadinessResponse } from '@lending/shared'
import type { AbsorbSignals } from '../bots/absorb.ts'
import type { BotRegistry } from '../bots/runner.ts'
import type { Deployment } from '../deployment.ts'
import type { LedgerClient } from '../ledger/client.ts'
import type { TokenStatus } from '../ledger/token.ts'
import type { Metrics } from '../metrics.ts'
import { dec, midPrice } from '../protocol/math.ts'
import { attestationFor, feedFor, type Reader } from '../protocol/reader.ts'
import { poolNumbers } from '../protocol/views.ts'
import { INSTRUMENT_SLOTS } from '../config.ts'

export interface ReadinessDeps {
  deployment?: Deployment
  reader?: Reader
  bots?: BotRegistry
  credentials?: () => Record<string, TokenStatus>
  indexerLag?: () => number | null
  maxIndexerLag?: number
  metrics?: Metrics
  now?: () => number
  /** RELEASE_SHA: build commit for /health */
  release?: string | null
  /**
   * N5: backstop balance in USDCx. Present only in a process with the backstop credential.
   * `balance` → null: the balance cannot be read with the process's credentials (backstop changed
   * by rotation).
   */
  backstop?: { min: string; balance: () => Promise<string | null> }
  /** Б6: absorb and sale signals, in the process that runs the absorb bots */
  absorb?: () => Promise<AbsorbSignals>
  /**
   * Risk 6: supplyCap is in asset units, so a price rise raises the dollar exposure. Users'
   * collateral of one market worth more than this, USD, is a problem: the council reviews the cap.
   */
  collateralAlertUsd?: string
  /**
   * К6: net reserves (reserves + book value of the absorbed stock) below this, USDCx, is a problem.
   * Below zero the contract closes new loans and deposit withdrawals; on a new ledger it also
   * catches starting reserves that treasury has not added yet (deploy/TESTNET.md, step 6.7).
   */
  reservesAlertUsd?: string
}

/**
 * N5: free USDCx of the current backstop from ProtocolConfig, read with its credential.
 * `route` throws NoCredentialError if there is no credential for the party: then null, not zero.
 */
export function backstopBalanceSource(
  reader: Pick<Reader, 'roles' | 'holdings'>,
  d: Pick<Deployment, 'usdcx'>,
  route: (party: string) => unknown,
): () => Promise<string | null> {
  return async () => {
    const party = (await reader.roles()).backstop
    try {
      route(party)
    } catch {
      return null
    }
    const hs = await reader.holdings(party, d.usdcx)
    return hs.reduce((s, h) => s.plus(h.view.amount), dec(0)).toFixed()
  }
}

/** Fraction of the limit after which readiness is dropped early, before the contract rejects. */
export const READY_MARGIN = 0.8

/**
 * Process readiness (B-10): ledger, role credentials, bots, price age, indexer lag,
 * CBTC attestation and the Featured App right. 200: ready, 503: list of problems.
 */
export async function readiness(
  ledger: LedgerClient,
  deps: ReadinessDeps,
): Promise<ReadinessResponse> {
  const now = deps.now ?? Date.now
  const problems: string[] = []
  const version = await ledger.version()
  if (!version) problems.push('ledger is unavailable')
  const credentials = Object.fromEntries(
    Object.entries(deps.credentials?.() ?? {}).map(([r, s]) => [r, { ok: s.ok, error: s.error }]),
  )
  for (const [role, s] of Object.entries(credentials))
    if (!s.ok) problems.push(`ledger credential ${role}: ${s.error ?? 'failing'}`)
  const bots = deps.bots?.list() ?? []
  for (const b of bots) if (b.state === 'error') problems.push(`bot ${b.name} is failing`)
  if (deps.absorb) {
    try {
      const a = await deps.absorb()
      if (a.staleAbsorbable > 0)
        problems.push(`${a.staleAbsorbable} liquidatable account(s) not absorbed in time`)
      for (const m of a.staleStock) problems.push(`absorbed ${m} collateral unsold for too long`)
      if (a.buyersShort) problems.push('buyers hold less USDCx than the absorbed collateral costs')
      if (a.unpricedDebt > 0)
        problems.push(
          `${a.unpricedDebt} account(s) with debt cannot be valued for absorb: a price is not usable`,
        )
    } catch {
      problems.push('absorb signals unavailable')
    }
  }

  const priceAgeSeconds: Record<string, number | null> = {}
  let attestationAgeSeconds: number | null = null
  if (deps.reader && deps.deployment) {
    const d = deps.deployment
    try {
      const s = await deps.reader.cachedSnapshot()
      const params = s.config.payload.params
      const maxAge = Number(params.maxPriceAgeSeconds)
      for (const slot of INSTRUMENT_SLOTS) {
        const instrument = d[slot]
        if (!instrument) continue
        const feed = feedFor(s, instrument)
        const oldest = feed?.payload.quotes.length
          ? Math.min(...feed.payload.quotes.map((q) => new Date(q.observedAt).getTime()))
          : null
        const age = oldest === null ? null : Math.max(0, Math.round((now() - oldest) / 1000))
        priceAgeSeconds[slot] = age
        deps.metrics?.gauge(
          'price_feed_age_seconds',
          'age of the oldest on-ledger quote',
          age ?? -1,
          {
            instrument: slot,
          },
        )
        if (age === null)
          problems.push(
            // §4: a feed exists, but from the previous oracle; the new oracle has not published its
            // own yet
            s.feeds.some((f) => f.payload.oracle !== s.config.payload.roles.oracle)
              ? `no price feed of the current oracle for ${slot}`
              : `no price feed for ${slot}`,
          )
        else if (age > maxAge * READY_MARGIN)
          problems.push(`price of ${slot} is ${age}s old (limit ${maxAge}s)`)
      }
      if (deps.collateralAlertUsd)
        for (const [id, m] of s.markets) {
          const mp = s.marketParams.get(id)
          const feed = mp && feedFor(s, mp.collateralInstrument)
          if (!feed?.payload.quotes.length) continue
          const usd = dec(m.totalCollateral).mul(midPrice(feed.payload.quotes.map((q) => q.price)))
          deps.metrics?.gauge(
            'lending_collateral_usd',
            'users collateral at mid price',
            usd.toNumber(),
            {
              market: id,
            },
          )
          if (usd.gt(deps.collateralAlertUsd))
            problems.push(
              `${id} collateral is worth $${usd.toDecimalPlaces(0, 1).toFixed()}, above COLLATERAL_ALERT_USD ${deps.collateralAlertUsd}: the council reviews supplyCap`,
            )
        }
      if (deps.reservesAlertUsd !== undefined) {
        const net = poolNumbers(s, new Date(now())).netReserves
        deps.metrics?.gauge(
          'lending_net_reserves',
          'reserves + absorbed stock book value, USDCx',
          net.toNumber(),
        )
        if (net.lt(deps.reservesAlertUsd))
          problems.push(
            net.lt(0)
              ? `net reserves are ${net.toDecimalPlaces(2, 3).toFixed(2)} USDCx: new loans and deposit withdrawals are closed until treasury adds reserves`
              : `net reserves are ${net.toDecimalPlaces(2, 3).toFixed(2)} USDCx, below RESERVES_ALERT_USD ${deps.reservesAlertUsd}: treasury adds reserves`,
          )
      }
      const att = attestationFor(s, d.cbtc)
      const cbtc = [...s.marketParams.values()].find(
        (m) =>
          m.collateralInstrument.admin === d.cbtc.admin && m.collateralInstrument.id === d.cbtc.id,
      )
      if (att) {
        attestationAgeSeconds = Math.max(
          0,
          Math.round((now() - new Date(att.payload.attestedAt).getTime()) / 1000),
        )
        deps.metrics?.gauge(
          'reserve_attestation_age_seconds',
          'age of the CBTC proof of reserve attestation',
          attestationAgeSeconds,
        )
        // B-8: the CBTC market does not close silently: alert before the attestation expires
        const maxAtt = cbtc ? Number(cbtc.maxAttestationAgeSeconds) : Infinity
        if (cbtc?.requiresReserveAttestation && attestationAgeSeconds > maxAtt * READY_MARGIN)
          problems.push(
            `CBTC reserve attestation is ${attestationAgeSeconds}s old (limit ${maxAtt}s): borrowing against CBTC stops at the limit`,
          )
      } else if (cbtc?.requiresReserveAttestation) problems.push('no CBTC reserve attestation')
      // A-25: Featured App right revoked: all money operations will stop
      if (s.config.payload.featuredAppRight && !s.featuredAppRight)
        problems.push('the Featured App right in ProtocolConfig is not active')
    } catch (err) {
      problems.push(
        `protocol state unavailable: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
      )
    }
  }

  let backstopBalance: string | null = null
  if (deps.backstop) {
    try {
      const b = await deps.backstop.balance()
      if (b === null)
        problems.push('backstop balance is unreadable with the ledger users of this process')
      else {
        backstopBalance = dec(b).toFixed(10, 1)
        deps.metrics?.gauge(
          'lending_backstop_balance',
          'free USDCx of the backstop party',
          dec(b).toDecimalPlaces(2, 1).toNumber(),
        )
        if (dec(b).lt(deps.backstop.min))
          problems.push(
            `backstop holds ${dec(b).toDecimalPlaces(2, 1).toFixed()} USDCx, below BACKSTOP_MIN_BALANCE ${deps.backstop.min}`,
          )
      }
    } catch (err) {
      problems.push(
        `backstop balance unavailable: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
      )
    }
  }

  const indexerLag = deps.indexerLag?.() ?? null
  if (indexerLag !== null && indexerLag > (deps.maxIndexerLag ?? 10_000))
    problems.push(`indexer is ${indexerLag} offsets behind`)

  return {
    ready: problems.length === 0,
    problems,
    ledger: version ? 'connected' : 'unavailable',
    credentials,
    bots,
    priceAgeSeconds,
    indexerLag,
    attestationAgeSeconds,
    backstopBalance,
  }
}

export const healthRoutes =
  (ledger: LedgerClient, deps: ReadinessDeps = {}): FastifyPluginAsync =>
  async (app) => {
    app.get('/health', async (): Promise<HealthResponse> => {
      const version = await ledger.version()
      return {
        status: 'ok',
        version: process.env.npm_package_version ?? '0.0.0',
        release: deps.release ?? null,
        ledger: version ? 'connected' : 'unavailable',
      }
    })

    app.get('/health/ready', async (_req, reply) => {
      const r = await readiness(ledger, deps)
      return reply.status(r.ready ? 200 : 503).send(r)
    })

    app.get('/metrics', async (_req, reply) => {
      const bots = deps.bots?.list() ?? []
      for (const b of bots) {
        deps.metrics?.gauge(
          'bot_last_success_timestamp_seconds',
          'unix time of the last successful bot step',
          b.lastSuccessAt ? Date.parse(b.lastSuccessAt) / 1000 : 0,
          { bot: b.name },
        )
        deps.metrics?.gauge(
          'bot_consecutive_failures',
          'failed bot steps in a row',
          b.consecutiveFailures,
          {
            bot: b.name,
          },
        )
        deps.metrics?.gauge(
          'bot_up',
          '1 — the bot is not in the error state',
          b.state === 'error' ? 0 : 1,
          {
            bot: b.name,
          },
        )
      }
      for (const [role, s] of Object.entries(deps.credentials?.() ?? {}))
        deps.metrics?.gauge(
          'ledger_credential_ok',
          '1 — the ledger token of the role works',
          s.ok ? 1 : 0,
          {
            role,
          },
        )
      const lag = deps.indexerLag?.()
      if (lag !== null && lag !== undefined)
        deps.metrics?.gauge('indexer_lag_offsets', 'ledger end minus indexer checkpoint', lag)
      return reply.type('text/plain; version=0.0.4').send(deps.metrics?.render() ?? '')
    })
  }
