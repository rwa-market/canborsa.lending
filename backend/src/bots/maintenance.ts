/**
 * Maintenance (audit S3, N6):
 * - attestation: demo mode renews the CBTC reserve attestation with the same coverage;
 *   live mode publishes the Proof of Reserve source data (B-8, ReserveSource). Without a source
 *   the bot does not start in live mode, and a stale attestation shows in /health/ready: the market
 *   does not close silently;
 * - merge: merges operator holdings by a transfer to itself when there are more than 5 per
 *   instrument;
 * - logins: removes abandoned Logins via Login_Expire (follow-up audit M5), and Logins without
 *   an expiry or with an expiry beyond the ceiling via Login_Reap (agreement §2).
 */
import type { FastifyBaseLogger } from 'fastify'
import { type Deployment, instrumentsOf } from '../deployment.ts'
import type { LedgerClient } from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import { type ReserveAttestationPayload, sameInstrument } from '../protocol/types.ts'
import type { Reader } from '../protocol/reader.ts'
import type { TokenRegistry } from '../protocol/registry.ts'
import { trustedFactory } from '../protocol/reader.ts'
import { dec } from '../protocol/math.ts'
import type { LoginPayload } from '../protocol/types.ts'
import type { ActiveContract } from '../ledger/client.ts'

/** Ceiling of Login expiry in Daml (maxLoginTtl, agreement §2). */
export const DAML_MAX_LOGIN_TTL_MS = 15 * 60_000
/** Margin for backend/ledger clock drift: Login_Reap must not fail at the boundary. */
export const REAP_MARGIN_MS = 60_000

/** What to do with a Login: expire if expired, reap if expiry is past the ceiling, keep if live. */
export function loginAction(l: Pick<LoginPayload, 'expiresAt'>, now: number) {
  if (!l.expiresAt) return 'expire' as const
  const exp = new Date(l.expiresAt).getTime()
  if (exp <= now) return 'expire' as const
  if (exp > now + DAML_MAX_LOGIN_TTL_MS + REAP_MARGIN_MS) return 'reap' as const
  return 'keep' as const
}

/** Reserve attestation from the Proof of Reserve source (B-8). */
export interface ReserveSource {
  name: string
  fetch(): Promise<{ coverage: string; attestedAt: string }>
}

/**
 * HTTP PoR source: JSON `{coverage, attestedAt}` or `{reserves, supply, asOf}`.
 * Coverage is a Decimal string; the time must not be more than a minute in the future.
 */
export function httpReserveSource(
  url: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  now: () => number = Date.now,
): ReserveSource {
  return {
    name: new URL(url).host,
    async fetch() {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`reserve source ${new URL(url).host}: HTTP ${res.status}`)
      const b = (await res.json()) as Record<string, unknown>
      const num = (v: unknown) =>
        typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)
          ? dec(v)
          : typeof v === 'number' && Number.isFinite(v) && v >= 0
            ? dec(v)
            : null
      const coverage =
        num(b.coverage) ??
        (() => {
          const r = num(b.reserves)
          const s = num(b.supply)
          return r && s && s.gt(0) ? r.div(s) : null
        })()
      const time = (b.attestedAt ?? b.asOf) as string | undefined
      const t = time ? Date.parse(time) : NaN
      if (!coverage || Number.isNaN(t)) throw new Error('reserve source: malformed response')
      if (t > now() + 60_000) throw new Error('reserve source: attestation from the future')
      return { coverage: coverage.toFixed(10, 1), attestedAt: new Date(t).toISOString() }
    },
  }
}

export function createMaintenance(
  ledger: LedgerClient,
  reader: Reader,
  registry: TokenRegistry,
  d: Deployment,
  oracleMode: 'demo' | 'live',
  log: FastifyBaseLogger,
  reserveSource?: ReserveSource,
) {
  /** Attestations are read by the oracle: the oracle process needs no operator rights. */
  const attestations = async () =>
    // Own only: after an oracle rotation the contract rejects old attestations (§4, 0.4.0)
    (
      await ledger.query<ReserveAttestationPayload>(d.oracle, {
        templateId: TEMPLATES.reserveAttestation,
      })
    ).filter((a) => a.payload.oracle === d.oracle)

  async function attestation(): Promise<number> {
    if (oracleMode !== 'demo') {
      // live (B-8): only PoR source data; replaying an old attestation is forbidden (M3)
      if (!reserveSource) return 0
      const fresh = await reserveSource.fetch()
      let n = 0
      const own = await attestations()
      if (!own.some((a) => sameInstrument(a.payload.instrumentId, d.cbtc))) {
        // New oracle after rotation: no own CBTC attestation, create one from source data
        await ledger.submit(
          [d.oracle],
          [
            {
              CreateCommand: {
                templateId: TEMPLATES.reserveAttestation,
                createArguments: {
                  oracle: d.oracle,
                  instrumentId: d.cbtc,
                  coverage: fresh.coverage,
                  attestedAt: fresh.attestedAt,
                  observers: [d.operator],
                },
              },
            },
          ],
        )
        log.warn({ source: reserveSource.name }, 'reserve attestation created for this oracle')
        return 1
      }
      for (const a of own) {
        if (!sameInstrument(a.payload.instrumentId, d.cbtc)) continue
        if (new Date(fresh.attestedAt) <= new Date(a.payload.attestedAt)) continue
        await ledger.submit(
          [d.oracle],
          [
            {
              ExerciseCommand: {
                templateId: TEMPLATES.reserveAttestation,
                contractId: a.contractId,
                choice: 'ReserveAttestation_Update',
                choiceArgument: { newCoverage: fresh.coverage, newAttestedAt: fresh.attestedAt },
              },
            },
          ],
        )
        n++
        log.info(
          {
            instrument: a.payload.instrumentId.id,
            coverage: fresh.coverage,
            source: reserveSource.name,
          },
          'reserve attestation published',
        )
      }
      return n
    }
    let n = 0
    for (const a of await attestations()) {
      const age = Date.now() - new Date(a.payload.attestedAt).getTime()
      if (age < 3_600_000) continue
      await ledger.submit(
        [d.oracle],
        [
          {
            ExerciseCommand: {
              templateId: TEMPLATES.reserveAttestation,
              contractId: a.contractId,
              choice: 'ReserveAttestation_Update',
              choiceArgument: {
                newCoverage: a.payload.coverage,
                newAttestedAt: new Date().toISOString(),
              },
            },
          },
        ],
      )
      n++
      log.info({ instrument: a.payload.instrumentId.id }, 'reserve attestation refreshed')
    }
    return n
  }

  async function merge(): Promise<number> {
    const s = await reader.snapshot()
    let n = 0
    for (const instrument of Object.values(instrumentsOf(d))) {
      const hs = await reader.holdings(d.operator, instrument)
      if (hs.length <= 5) continue
      const total = hs.reduce((sum, h) => sum.plus(h.view.amount), dec(0))
      const factory = await registry.transferFactory(instrument, trustedFactory(s, instrument), {
        sender: d.operator,
        receiver: d.operator,
        amount: total.toFixed(10),
        inputHoldingCids: hs.map((h) => h.contract.contractId),
      })
      const now = new Date()
      await ledger.submit(
        [d.operator],
        [
          {
            ExerciseCommand: {
              templateId:
                '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
              contractId: factory.factoryCid,
              choice: 'TransferFactory_Transfer',
              choiceArgument: {
                expectedAdmin: instrument.admin,
                transfer: {
                  sender: d.operator,
                  receiver: d.operator,
                  amount: total.toFixed(10),
                  instrumentId: instrument,
                  requestedAt: now.toISOString(),
                  executeBefore: new Date(now.getTime() + 3_600_000).toISOString(),
                  inputHoldingCids: hs.map((h) => h.contract.contractId),
                  meta: { values: {} },
                },
                extraArgs: factory.transferExtraArgs,
              },
            },
          },
        ],
        factory.disclosed,
      )
      n++
      log.info({ instrument: instrument.id, from: hs.length }, 'operator holdings merged')
    }
    return n
  }

  /** Login_Reap is absent in the deployed package (before 0.4.0): do not retry every cycle. */
  let reapUnsupported = false

  async function logins(): Promise<number> {
    const now = Date.now()
    const all: ActiveContract<LoginPayload>[] = await reader.logins()
    const expire = all.filter((l) => loginAction(l.payload, now) === 'expire')
    const reap = all.filter((l) => loginAction(l.payload, now) === 'reap')
    const batch = async (items: typeof all, choice: 'Login_Expire' | 'Login_Reap') => {
      // In batches: one transaction per 25 logins, like rejecting account requests
      for (let i = 0; i < items.length; i += 25) {
        await ledger.submit(
          [d.operator],
          items.slice(i, i + 25).map((l) => ({
            ExerciseCommand: {
              templateId: TEMPLATES.login,
              contractId: l.contractId,
              choice,
              choiceArgument: {},
            },
          })),
        )
      }
    }
    await batch(expire, 'Login_Expire')
    let reaped = 0
    if (reap.length && !reapUnsupported) {
      try {
        await batch(reap, 'Login_Reap')
        reaped = reap.length
      } catch (err) {
        if (/Login_Reap|unknown choice|NO_SUCH_CHOICE|not found/i.test(String(err))) {
          reapUnsupported = true
          log.error(
            { count: reap.length },
            'Login_Reap is not in the deployed lending-core: upgrade to 0.4.0',
          )
        } else throw err
      }
    }
    if (expire.length) log.info({ count: expire.length }, 'expired logins archived')
    if (reaped) log.warn({ count: reaped }, 'logins beyond the TTL cap reaped')
    return expire.length + reaped
  }

  return { attestation, merge, logins }
}
