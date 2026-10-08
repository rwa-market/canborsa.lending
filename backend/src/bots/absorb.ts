/**
 * Absorb and collateral sale bots (Б6, K5), instead of monitor, liquidator, backstop, settle, sweep:
 * - absorber (operator): finds accounts whose debt exceeds the liquidation point at the lower
 *   collateral quote and the higher USDCx quote and submits Pool_Absorb. No tokens move, so it does
 *   not depend on anyone's USDCx;
 * - buyer (liquidator, backstop): buys absorbed collateral while reserves are below the target,
 *   with a minimum to receive. The backstop is the protocol's reserve buyer: it steps in when the
 *   stock has waited for a while.
 * Every step is idempotent: the command id is a domain key, and the contract rejects an absorb of a
 * healthy or already absorbed account and a purchase without stock.
 */
import { Decimal } from 'decimal.js'
import { createHash } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { type Deployment, MARKETS } from '../deployment.ts'
import type { LedgerClient } from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import type { CommandBuilder } from '../protocol/commands.ts'
import { dec, type Dec, liquidationPoint, presentValue } from '../protocol/math.ts'
import { collateralOf, feedFor, type Reader, type Snapshot } from '../protocol/reader.ts'
import type { AccountPayload } from '../protocol/types.ts'
import {
  collateralLines,
  indicesAt,
  poolNumbers,
  priceView,
  quoteCollateral,
  saleView,
} from '../protocol/views.ts'
import { isContention } from './runner.ts'

/** Command id from the domain key (B-15): the same account version gives the same absorb. */
export const absorbCommandId = (accountCid: string) =>
  `absorb-${createHash('sha256').update(accountCid).digest('hex').slice(0, 32)}`

/**
 * The account is absorbable now: debt × higher USDCx quote above the liquidation point at the lower
 * collateral quotes, with the absorb tolerance. null: some price is not usable, absorb would fail.
 */
export function absorbable(
  s: Snapshot,
  d: Deployment,
  account: AccountPayload,
  now: Date,
): boolean | null {
  const principal = dec(account.principal)
  if (principal.gte(0)) return false
  const params = s.config.payload.params
  const debtPv = priceView(feedFor(s, d.usdcx), params, now)
  if (!debtPv?.liquidationValid) return null
  const point = liquidationPoint(collateralLines(s, collateralOf(account), now, true))
  if (point === null) return null
  const debt = presentValue(principal, indicesAt(s, now)).neg()
  return debt.mul(debtPv.debtPrice).gt(point)
}

export interface AbsorbSignals {
  /** Absorbable accounts not absorbed for longer than `absorbAlertMs` */
  staleAbsorbable: number
  /** Assets whose absorbed collateral has waited for sale longer than `stockAlertMs` */
  staleStock: string[]
  /** USDCx the buyers hold is less than the cost of the whole stock */
  buyersShort: boolean
  /**
   * Accounts with a debt that cannot be valued for absorb (a price fails the absorb tolerance) for
   * longer than `absorbAlertMs` (risk 4): they may be underwater while the absorber cannot act
   */
  unpricedDebt: number
}

export function createAbsorbBots(
  ledger: LedgerClient,
  reader: Reader,
  commands: CommandBuilder,
  d: Deployment,
  log: FastifyBaseLogger,
  opts: {
    /** Minimum to receive = quote × (1 − tolerance): price movement before execution */
    buyTolerance?: string
    /** The backstop buys only stock that has waited this long */
    backstopDelayMs?: number
    absorbAlertMs?: number
    stockAlertMs?: number
    now?: () => number
  } = {},
) {
  const clock = opts.now ?? Date.now
  const tolerance = dec(opts.buyTolerance ?? '0.02')
  const backstopDelayMs = opts.backstopDelayMs ?? 120_000
  const absorbAlertMs = opts.absorbAlertMs ?? 300_000
  const stockAlertMs = opts.stockAlertMs ?? 1_800_000
  /** accountCid → when it was first seen absorbable */
  const absorbableSince = new Map<string, number>()
  /** marketId → when its stock was first seen */
  const stockSince = new Map<string, number>()
  /** accountCid → when its debt was first seen without usable prices */
  const unpricedSince = new Map<string, number>()
  let buyersShort = false

  /** A step whose every attempt was rejected for a reason other than contention fails (Б6). */
  function failIfAllRejected(what: string, done: number, rejected: string[]) {
    if (done === 0 && rejected.length > 0)
      throw new Error(`${what} rejected ${rejected.length} time(s): ${rejected[0]!.slice(0, 200)}`)
  }

  async function absorber() {
    const s = await reader.snapshot()
    const now = new Date(clock())
    // Review 03.10, item 14: a council changed the guardian; the pause flags still name the old
    // one, and every pool operation is refused until they are rebound (the operator's choice)
    if (s.pause.payload.guardian !== s.config.payload.roles.guardian) {
      await ledger.submit(
        [d.operator],
        [
          {
            ExerciseCommand: {
              templateId: TEMPLATES.pauseState,
              contractId: s.pause.contractId,
              choice: 'PauseState_Rebind',
              choiceArgument: { configCid: s.config.contractId },
            },
          },
        ],
        [],
        [],
        {
          commandId: `pause-rebind-${createHash('sha256').update(s.pause.contractId).digest('hex').slice(0, 32)}`,
        },
      )
      log.warn(
        { guardian: s.config.payload.roles.guardian },
        'pause flags rebound to the new guardian',
      )
      return { absorbed: 0, rebound: true }
    }
    if (s.pause.payload.flags.absorbPaused) return { absorbed: 0, paused: true }
    const accounts = await reader.accounts()
    const seen = new Set<string>()
    const unpriced = new Set<string>()
    const rejected: string[] = []
    let absorbed = 0
    for (const account of accounts) {
      const verdict = absorbable(s, d, account.payload, now)
      if (verdict === null) {
        unpriced.add(account.contractId)
        if (!unpricedSince.has(account.contractId)) {
          unpricedSince.set(account.contractId, clock())
          // review 03.10, item 13: a skipped account is logged once, not silently passed over
          log.warn(
            { account: account.contractId },
            'account with debt skipped: a collateral or USDCx price is not usable for absorb',
          )
        }
        continue
      }
      if (!verdict) continue
      seen.add(account.contractId)
      if (!absorbableSince.has(account.contractId)) absorbableSince.set(account.contractId, clock())
      try {
        const fresh = await reader.snapshot()
        await ledger.submit([d.operator], [commands.absorbCommand(fresh, account)], [], [], {
          commandId: absorbCommandId(account.contractId),
        })
        absorbed++
        absorbableSince.delete(account.contractId)
        log.warn({ account: account.contractId }, 'account absorbed')
      } catch (err) {
        // contention on Pool: the next cycle retries with the new pool; other rejections are logged
        if (!isContention(err)) {
          rejected.push(String(err))
          log.error({ err: String(err) }, 'absorb rejected')
        } else log.info('absorb contended, retrying next cycle')
      }
    }
    for (const cid of absorbableSince.keys()) if (!seen.has(cid)) absorbableSince.delete(cid)
    for (const cid of unpricedSince.keys()) if (!unpriced.has(cid)) unpricedSince.delete(cid)
    failIfAllRejected('absorb', absorbed, rejected)
    return { absorbed }
  }

  /** Buy what the party's USDCx allows from every asset in stock. */
  async function buyAs(party: string, delayMs: number) {
    const s = await reader.snapshot()
    const roles = s.config.payload.roles
    // After a council role rotation this process no longer buys: say so instead of failing quietly
    if (party !== roles.backstop && !roles.liquidators.includes(party))
      throw new Error(
        `${party} is no longer an approved buyer in ProtocolConfig: update the credentials`,
      )
    const now = new Date(clock())
    const n = poolNumbers(s, now)
    trackStock(s)
    if (s.pause.payload.flags.buyPaused) return { bought: 0, paused: true }
    if (!n.reserves.lt(s.config.payload.params.targetReserves)) return { bought: 0, forSale: false }
    let bought = 0
    const rejected: string[] = []
    let usdcx = (await reader.holdings(party, d.usdcx)).reduce(
      (a, h) => a.plus(h.view.amount),
      dec(0),
    )
    for (const marketId of MARKETS) {
      const since = stockSince.get(marketId)
      if (since === undefined || clock() - since < delayMs) continue
      const sale = saleView(s, d, marketId, now)
      if (!sale?.price || dec(sale.available).lte(0)) continue
      // The whole stock for its cost (rounded up): the contract (1.0.2) then gives all of it, with no
      // rest of one token unit left behind. Otherwise what the wallet allows, at least 1 USDCx
      const cost = sale.costOfAll ? dec(sale.costOfAll) : null
      if (!cost) continue
      const pay = cost.lte(usdcx) ? Decimal.max(cost, dec('0.0000000001')) : Decimal10(usdcx)
      if (pay.lt(cost) && pay.lt(1)) continue
      const quote = quoteCollateral(sale, pay.toFixed(10))
      if (!quote || dec(quote).isZero()) continue
      const out = minDec(dec(quote), dec(sale.available))
      const min = out.mul(dec(1).minus(tolerance)).toDecimalPlaces(10, 1)
      try {
        const p = await commands.buyCollateral(party, marketId, pay.toFixed(10), min.toFixed(10))
        await ledger.submit(p.actAs, p.commands, p.disclosedContracts, [], {
          commandId: `buy-${createHash('sha256').update(`${s.pool.contractId}|${marketId}|${party}`).digest('hex').slice(0, 32)}`,
        })
        bought++
        usdcx = usdcx.minus(pay)
        log.info({ marketId, pay: pay.toFixed(10), party }, 'absorbed collateral bought')
      } catch (err) {
        if (!isContention(err)) {
          rejected.push(String(err))
          log.error({ err: String(err), marketId }, 'collateral purchase rejected')
        }
      }
    }
    failIfAllRejected('collateral purchase', bought, rejected)
    return { bought }
  }

  function trackStock(s: Snapshot) {
    for (const marketId of MARKETS) {
      const m = s.markets.get(marketId)
      if (m && dec(m.protocolCollateral).gt(0)) {
        if (!stockSince.has(marketId)) stockSince.set(marketId, clock())
      } else stockSince.delete(marketId)
    }
  }

  /** Readiness signals (Б6): an alert, not only a log line. */
  async function signals(): Promise<AbsorbSignals> {
    const s = await reader.snapshot()
    const now = new Date(clock())
    trackStock(s)
    // Stock waits by design while reserves are at the target or buying is paused: no alarm then
    const forSale =
      !s.pause.payload.flags.buyPaused &&
      poolNumbers(s, now).reserves.lt(s.config.payload.params.targetReserves)
    let cost = dec(0)
    for (const marketId of MARKETS) {
      const sale = saleView(s, d, marketId, now)
      if (sale?.costOfAll) cost = cost.plus(sale.costOfAll)
    }
    const buyers = [
      ...new Set([...s.config.payload.roles.liquidators, s.config.payload.roles.backstop]),
    ]
    try {
      let held = dec(0)
      for (const b of buyers)
        held = held.plus(
          (await reader.holdings(b, d.usdcx)).reduce((a, h) => a.plus(h.view.amount), dec(0)),
        )
      buyersShort = forSale && held.lt(cost)
    } catch {
      // the process may not read the buyers' holdings: keep the last known answer
    }
    return {
      staleAbsorbable: [...absorbableSince.values()].filter((t) => clock() - t > absorbAlertMs)
        .length,
      staleStock: forSale
        ? [...stockSince.entries()].filter(([, t]) => clock() - t > stockAlertMs).map(([m]) => m)
        : [],
      buyersShort,
      unpricedDebt: [...unpricedSince.values()].filter((t) => clock() - t > absorbAlertMs).length,
    }
  }

  return {
    absorber,
    liquidator: () => buyAs(d.liquidator, 0),
    backstop: () => buyAs(d.backstop, backstopDelayMs),
    signals,
  }
}

const minDec = (a: Dec, b: Dec) => (a.lt(b) ? a : b)
const Decimal10 = (v: Dec) => v.toDecimalPlaces(10, 1)
