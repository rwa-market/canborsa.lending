/**
 * deposits bot (ASSET_PROFILE=real only, seam 2). Incoming transfers to the EVM wallet
 * custodian are TransferInstructions in the custodian's ACS:
 *
 * - memo `lending:evm:<address>` in transfer.meta (key splice.lfdecentralizedtrust.org/reason)
 *   and a profile instrument → EvmWallet_ReceiveAttributed: the contract checks reason again.
 *   No account for the address: open it (EvmDirectory_Open); the deposit does not wait for login;
 * - no memo, someone else's memo, unknown instrument, contract rejection → quarantine (SQLite).
 *   The instruction is neither accepted nor rejected: without Accept it expires at executeBefore,
 *   and the tokens stay with the sender. Nothing is credited blindly.
 *
 * Idempotent by instruction cid: deposit_seen and commandId `evm-deposit-<sha(cid)>`.
 *
 * Outgoing custodian withdrawals (EvmTransferOut, Pending): if the recipient has not accepted the
 * transfer by executeBefore, the bot reclaims it with EvmWallet_ReclaimTransferOut (Withdraw
 * context from the registry), and the amount returns to the wallet. Idempotent: commandId
 * `evm-reclaim-<sha(cid)>`.
 *
 * Custodian transaction stream (cursor custody_cursor), custody-tx.ts:
 * - one-step deposit (CC via TransferPreapproval, no instruction): memo from the transaction
 *   that created custodian holdings → EvmWallet_CreditDeposit, depositRef =
 *   "<updateId>:<nodeId>". Memo `lending:evm:<address>`: exact prefix, a mixed-case address
 *   (EIP-55 checksum) is lowercased, only on this path; ReceiveAttributed
 *   checks reason in the contract and stays exact. No memo, someone else's memo, foreign instrument
 *   → quarantine (the tokens are already with the custodian, only a human can return them);
 * - withdrawal refund without our Reclaim (recipient Reject, Withdraw outside the protocol): the
 *   instruction amount → EvmWallet_CreditDeposit, depositRef = "refund:<transferCid>".
 * Retries are cut off by deposit_seen, commandId from depositRef and DepositRegistry on the ledger.
 * The cursor moves only past a processed transaction: on a network failure the same transaction
 * comes in the next cycle, and deposits in it that are already credited are skipped.
 *
 * Reconciliation: free custodian holdings minus balances of all EvmWallets and open withdrawal
 * requests is the metric deposits_unattributed (> 0: ownerless money, e.g. a direct transfer in
 * quarantine or a deposit before the stream's first run; < 0: shortfall).
 */
import type { FastifyBaseLogger } from 'fastify'
import {
  DEPOSIT_REASON_PREFIX,
  REASON_META_KEY,
  type RealProfile,
  sameInstrument,
} from '../assets/profiles.ts'
import { creditDeposit, CreditNotReadyError, NoDepositRegistryError } from '../assets/credit.ts'
import { parseCustodyTransaction } from '../assets/custody-tx.ts'
import type { QuarantineEntry, RealAssetsStore } from '../assets/store.ts'
import type { Deployment, Instrument } from '../deployment.ts'
import {
  classifyLedgerError,
  LedgerError,
  type LedgerClient,
  type LedgerTransaction,
} from '../ledger/client.ts'
import { INTERFACES, TEMPLATES } from '../ledger/ids.ts'
import type { Metrics } from '../metrics.ts'
import type { Evm } from '../protocol/evm.ts'
import { dec } from '../protocol/math.ts'
import type { Reader } from '../protocol/reader.ts'
import type { TokenRegistry } from '../protocol/registry.ts'
import type { EvmWalletPayload } from '../protocol/types.ts'

interface InstructionView {
  transfer?: {
    sender?: string
    receiver?: string
    amount?: string
    instrumentId?: Instrument
    executeBefore?: string
    meta?: { values?: Record<string, string> }
  }
}

/** memo → wallet address. Only the exact lowercase form: that is how the contract checks it. */
export function attributedAddress(reason: string | null | undefined): string | null {
  if (!reason?.startsWith(DEPOSIT_REASON_PREFIX)) return null
  const a = reason.slice(DEPOSIT_REASON_PREFIX.length)
  return /^0x[0-9a-f]{40}$/.test(a) ? a : null
}

/**
 * memo → address for EvmWallet_CreditDeposit (one-step deposit). The `lending:evm:` prefix is
 * exact; a 0x address with 40 hex in any case is lowercased: the wallet copies the address
 * with checksum, and here the contract does not check reason (credit by depositRef). For
 * ReceiveAttributed there is no normalization: there the contract checks reason exactly.
 */
export function creditAddress(reason: string | null | undefined): string | null {
  if (!reason?.startsWith(DEPOSIT_REASON_PREFIX)) return null
  const a = reason.slice(DEPOSIT_REASON_PREFIX.length)
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null
}

/** Margin after executeBefore before reclaiming: ledger time and the bot's clock may drift. */
export const RECLAIM_GRACE_MS = 60_000
const CURSOR = 'custody'
const STREAM_PAGE = 200
const STREAM_MAX_PAGES = 20

const SLOTS = ['usdcx', 'cc', 'cbtc'] as const

type QuarantineEntryBase = Omit<QuarantineEntry, 'cause'>

export function createDepositsBot(deps: {
  ledger: LedgerClient
  reader: Reader
  evm: Evm
  registry: TokenRegistry
  store: RealAssetsStore
  deployment: Deployment
  profile: RealProfile
  log: FastifyBaseLogger
  metrics?: Metrics
  now?: () => number
}) {
  const { ledger, store, evm, profile } = deps
  const now = deps.now ?? Date.now
  const custody = deps.deployment.evm?.custody
  if (!custody) throw new Error('BOTS=deposits needs deployment.json evm.custody')
  const slotOf = (i: Instrument | undefined) =>
    i ? SLOTS.find((s) => sameInstrument(profile.instruments[s], i)) : undefined

  const credited = (slot: string) =>
    deps.metrics?.inc('deposits_credited_total', 'Deposits credited to EVM wallets', { slot })
  const quarantined = (cause: string) =>
    deps.metrics?.inc('deposits_quarantined_total', 'Deposits put in quarantine', { cause })

  async function step() {
    const instructions = await ledger.query<unknown>(custody!, {
      interfaceId: INTERFACES.transferInstruction,
    })
    let failed: unknown = null
    for (const c of instructions) {
      const t = (c.interfaceView as InstructionView | undefined)?.transfer
      if (!t) continue
      // Outgoing custodian withdrawals (EvmTransferOut) are here too: the recipient awaits them
      if (t.sender === custody) {
        if (t.receiver !== custody) failed = (await reclaimExpired(c.contractId, t)) ?? failed
        continue
      }
      if (t.receiver !== custody) continue
      if (store.seen(c.contractId)) continue
      const reason = t.meta?.values?.[REASON_META_KEY]
      const base = {
        id: c.contractId,
        source: 'instruction' as const,
        ...(t.instrumentId ? { instrument: t.instrumentId } : {}),
        ...(t.amount ? { amount: t.amount } : {}),
        ...(t.sender ? { sender: t.sender } : {}),
        ...(reason ? { reason: reason.slice(0, 200) } : {}),
      }
      const slot = slotOf(t.instrumentId)
      if (!slot) {
        store.quarantine({ ...base, cause: 'unknown-instrument' })
        quarantined('unknown-instrument')
        continue
      }
      const address = attributedAddress(reason)
      if (!address || !t.amount || !dec(t.amount).gt(0)) {
        const cause = reason ? 'bad-reason' : 'no-reason'
        store.quarantine({ ...base, cause })
        quarantined(cause)
        deps.log.warn(
          { event: 'deposit_quarantined', cause, slot, cid: c.contractId.slice(0, 16) },
          'incoming transfer without a valid deposit memo: quarantined',
        )
        continue
      }
      try {
        await evm.ensureAccount(address)
        const accept = deps.registry.acceptContext
          ? await deps.registry.acceptContext(t.instrumentId!, c.contractId)
          : { extraArgs: { context: { values: {} }, meta: { values: {} } }, disclosed: [] }
        const r = await evm.receiveAttributed(address, c.contractId, accept)
        store.markCredited(c.contractId, address, r.updateId)
        credited(slot)
        deps.log.info(
          { event: 'deposit_credited', slot, amount: t.amount, address },
          'deposit credited to EVM wallet',
        )
      } catch (err) {
        const kind = classifyLedgerError(err)
        if (kind === 'duplicate') {
          store.markCredited(c.contractId, address, 'duplicate')
          continue
        }
        if (kind === 'rejected' && err instanceof LedgerError) {
          store.quarantine({ ...base, cause: 'rejected', detail: err.publicText })
          quarantined('rejected')
          deps.log.warn(
            { event: 'deposit_quarantined', cause: 'rejected', slot, err: err.publicText },
            'contract refused the deposit: quarantined',
          )
          continue
        }
        // network, registry, contract contention: retry in the next cycle
        failed = err
        deps.metrics?.inc('deposits_retry_total', 'Deposit attempts to retry', { slot })
        deps.log.warn({ event: 'deposit_retry', slot, err: String(err) }, 'deposit will be retried')
      }
    }
    failed = (await stream()) ?? failed
    for (const [cause, n] of Object.entries(store.quarantineCounts()))
      deps.metrics?.gauge('deposits_quarantine_open', 'Open quarantine entries', n ?? 0, { cause })
    await reconcile()
    if (failed) throw failed
  }

  const creditDeps = {
    ledger,
    reader: deps.reader,
    ensureAccount: (a: string) => evm.ensureAccount(a),
    operator: deps.deployment.operator,
    custody: custody!,
  }

  /** A self-resolving failure: network, busy contract, account or holdings not visible yet. */
  const retryable = (err: unknown) =>
    err instanceof CreditNotReadyError ||
    err instanceof NoDepositRegistryError ||
    !(err instanceof LedgerError) ||
    classifyLedgerError(err) !== 'rejected'

  /** Withdrawal not accepted by executeBefore: reclaim it (EvmWallet_ReclaimTransferOut). */
  async function reclaimExpired(
    cid: string,
    t: NonNullable<InstructionView['transfer']>,
  ): Promise<unknown> {
    const expires = Date.parse(t.executeBefore ?? '')
    if (!Number.isFinite(expires) || expires + RECLAIM_GRACE_MS > now()) return null
    const id = `reclaim:${cid}`
    if (store.seen(id)) return null
    // EVM wallet withdrawals only: the contract sets reason itself, exactly lowercase
    const address = attributedAddress(t.meta?.values?.[REASON_META_KEY])
    const slot = slotOf(t.instrumentId)
    if (!address || !slot) return null
    try {
      const ctx = deps.registry.withdrawContext
        ? await deps.registry.withdrawContext(t.instrumentId!, cid)
        : { extraArgs: { context: { values: {} }, meta: { values: {} } }, disclosed: [] }
      const r = await evm.reclaimTransferOut(address, cid, ctx)
      store.markCredited(id, address, r.updateId)
      deps.metrics?.inc('deposits_reclaimed_total', 'Expired withdrawals reclaimed', { slot })
      deps.log.info(
        { event: 'transfer_out_reclaimed', slot, amount: t.amount, address },
        'expired withdrawal reclaimed to the EVM wallet',
      )
      return null
    } catch (err) {
      const kind = classifyLedgerError(err)
      if (kind === 'duplicate') {
        store.markCredited(id, address, 'duplicate')
        return null
      }
      if (kind === 'rejected' && err instanceof LedgerError) {
        // The instruction is gone (recipient Reject): the transaction stream will credit the refund
        if (/^STALE_CONTRACT/.test(err.publicText)) return null
        store.quarantine({
          id,
          source: 'reclaim',
          cause: 'reclaim-rejected',
          ...(t.instrumentId ? { instrument: t.instrumentId } : {}),
          ...(t.amount ? { amount: t.amount } : {}),
          sender: address,
          detail: err.publicText,
        })
        quarantined('reclaim-rejected')
        deps.log.error(
          { event: 'transfer_out_reclaim_rejected', slot, address, err: err.publicText },
          'expired withdrawal could not be reclaimed: quarantined',
        )
        return null
      }
      deps.log.warn({ event: 'reclaim_retry', slot, err: String(err) }, 'reclaim will be retried')
      return err
    }
  }

  /** Custodian transaction stream from the cursor: one-step deposits and withdrawal refunds. */
  async function stream(): Promise<unknown> {
    const from0 = store.cursor(CURSOR)
    const end = await ledger.ledgerEnd()
    if (from0 === null) {
      // First run: deposits before it are visible only in deposits_unattributed
      store.setCursor(CURSOR, end)
      deps.log.info({ event: 'custody_stream_start', offset: end }, 'custody stream starts here')
      return null
    }
    const pruned = await ledger.prunedOffset()
    if (from0 < pruned)
      throw new Error(
        `custody stream cursor ${from0} is behind the pruned offset ${pruned}: deposits in between need a manual review`,
      )
    let from = from0
    for (let page = 0; page < STREAM_MAX_PAGES && from < end; page++) {
      const r = await ledger.transactions(custody!, from, end, STREAM_PAGE, [
        INTERFACES.holding,
        INTERFACES.transferInstruction,
      ])
      for (const tx of [...r.transactions].sort((a, b) => a.offset - b.offset)) {
        const err = await handleTransaction(tx)
        if (err) return err
        store.setCursor(CURSOR, tx.offset)
      }
      from = r.lastOffset ?? end
      store.setCursor(CURSOR, from)
      if (r.count < STREAM_PAGE) break
    }
    return null
  }

  async function handleTransaction(tx: LedgerTransaction): Promise<unknown> {
    const { incoming, returned } = parseCustodyTransaction(tx, custody!)
    for (const x of incoming) {
      if (store.seen(x.depositRef)) continue
      const base = {
        id: x.depositRef,
        source: 'preapproval' as const,
        instrument: x.instrument,
        amount: x.amount,
        ...(x.sender ? { sender: x.sender } : {}),
        ...(x.reason ? { reason: x.reason.slice(0, 200) } : {}),
      }
      const slot = slotOf(x.instrument)
      if (!slot) {
        store.quarantine({ ...base, cause: 'unknown-instrument' })
        quarantined('unknown-instrument')
        continue
      }
      const address = creditAddress(x.reason)
      if (!address) {
        const cause = x.reason ? 'bad-reason' : 'no-reason'
        store.quarantine({ ...base, cause })
        quarantined(cause)
        deps.log.warn(
          { event: 'deposit_quarantined', cause, slot, ref: x.depositRef },
          'direct deposit without a valid memo: quarantined, the tokens are at the custody party',
        )
        continue
      }
      const err = await credit(base, slot, address, x.amount, 'credited')
      if (err) return err
    }
    for (const x of returned) {
      const id = `refund:${x.instructionCid}`
      if (store.seen(id)) continue
      const ev = await ledger.createdEvent(
        custody!,
        x.instructionCid,
        INTERFACES.transferInstruction,
      )
      const t = (ev?.interfaceView as InstructionView | undefined)?.transfer
      // The incoming instruction was withdrawn by its sender: the tokens are not ours
      if (t && t.sender !== custody) continue
      const address = attributedAddress(t?.meta?.values?.[REASON_META_KEY])
      const slot = slotOf(t?.instrumentId)
      const base = {
        id,
        source: 'refund' as const,
        ...(t?.instrumentId ? { instrument: t.instrumentId } : {}),
        ...(t?.amount ? { amount: t.amount } : {}),
      }
      if (!t || !address || !slot || !t.amount) {
        store.quarantine({
          ...base,
          cause: 'refund-unattributed',
          detail: t ? 'returned transfer is not from an EVM wallet' : 'instruction not visible',
        })
        quarantined('refund-unattributed')
        deps.log.error(
          { event: 'refund_unattributed', cid: x.instructionCid.slice(0, 16) },
          'tokens of a failed withdrawal came back but cannot be attributed: quarantined',
        )
        continue
      }
      const err = await credit({ ...base, sender: address }, slot, address, t.amount, 'refunded')
      if (err) return err
    }
    return null
  }

  /** EvmWallet_CreditDeposit by record id (depositRef). A retryable failure returns an error. */
  async function credit(
    base: QuarantineEntryBase,
    slot: (typeof SLOTS)[number],
    address: string,
    amount: string,
    outcome: 'credited' | 'refunded',
  ): Promise<unknown> {
    try {
      const r = await creditDeposit(creditDeps, {
        address,
        instrument: profile.instruments[slot],
        amount,
        depositRef: base.id,
      })
      store.markCredited(base.id, address, r.state === 'credited' ? r.updateId : 'already')
      if (outcome === 'credited') credited(slot)
      else
        deps.metrics?.inc('deposits_refunded_total', 'Failed withdrawals credited back', { slot })
      deps.log.info(
        {
          event: outcome === 'credited' ? 'deposit_credited' : 'withdrawal_refunded',
          slot,
          amount,
          address,
          ref: base.id,
        },
        outcome === 'credited'
          ? 'direct deposit credited to EVM wallet'
          : 'failed withdrawal credited back',
      )
      return null
    } catch (err) {
      if (retryable(err)) {
        deps.metrics?.inc('deposits_retry_total', 'Deposit attempts to retry', { slot })
        deps.log.warn({ event: 'deposit_retry', slot, err: String(err) }, 'deposit will be retried')
        return err
      }
      const detail = err instanceof LedgerError ? err.publicText : String(err)
      store.quarantine({ ...base, cause: 'rejected', detail })
      quarantined('rejected')
      deps.log.error(
        { event: 'deposit_quarantined', cause: 'rejected', slot, err: detail },
        'contract refused the credit: quarantined',
      )
      return null
    }
  }

  /** Free custodian holdings vs the total of wallets and withdrawal requests, per slot. */
  async function reconcile() {
    const [wallets, redeems] = await Promise.all([
      ledger.query<EvmWalletPayload>(deps.deployment.operator, { templateId: TEMPLATES.evmWallet }),
      ledger
        .query<{ instrumentId?: Instrument; amount: string }>(custody!, {
          templateId: TEMPLATES.redeemRequest,
        })
        .catch(() => []),
    ])
    for (const slot of SLOTS) {
      const i = profile.instruments[slot]
      const held = (await deps.reader.holdings(custody!, i)).reduce(
        (s, h) => s.plus(h.view.amount),
        dec(0),
      )
      const owed = wallets
        .filter((w) => w.payload.custody === custody)
        .reduce(
          (s, w) => s.plus(w.payload.balances.find(([k]) => sameInstrument(k, i))?.[1] ?? '0'),
          dec(0),
        )
      const pending = redeems
        .filter(
          (r) =>
            slot === 'usdcx' &&
            (!r.payload.instrumentId || sameInstrument(r.payload.instrumentId, i)),
        )
        .reduce((s, r) => s.plus(r.payload.amount), dec(0))
      const diff = held.minus(owed).minus(pending)
      deps.metrics?.gauge(
        'deposits_unattributed',
        'Custody holdings not owed to any EVM wallet (>0 unattributed, <0 shortfall)',
        Number(diff.toFixed(10)),
        { slot },
      )
    }
  }

  return step
}
