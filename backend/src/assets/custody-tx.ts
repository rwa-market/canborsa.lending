/**
 * Parsing custodian transactions (real assets, 0.6.0): what arrived as holdings without
 * a TransferInstruction and what came back from a failed withdrawal.
 *
 * 1. One-step deposit (CC via TransferPreapproval). Algorithm from the Canton Exchange
 *    Integration Guide ("Transaction Parsing → 1-Step Transfers"): an ExercisedEvent node whose
 *    exerciseResult.meta has `tx-kind = transfer` is a transfer; the memo is its `reason`;
 *    the amount is the custodian holdings created in the subtree (nodeId, lastDescendantNodeId].
 *    depositRef = "<updateId>:<nodeId of the transfer node>": one node, one deposit, even if
 *    the transfer created several holdings and the transaction holds several deposits.
 * 2. Withdrawal refund. A consuming exercise on a TransferInstruction with result
 *    TransferInstructionResult_Failed (recipient Reject, Withdraw not via our choice):
 *    the tokens returned to the custodian. The bot decides whose withdrawal it is by the
 *    instruction kind.
 *
 * Subtrees of our choices are skipped entirely: EvmWallet_*, Pool_* and other Lending.*
 * templates, the DA Utilities bridge. There the protocol itself creates custodian holdings
 * (instruction credit, withdrawal change, ReclaimTransferOut, xReserve mint), and they are already
 * accounted for.
 */
import type { Instrument } from '../deployment.ts'
import type { LedgerTransaction, LedgerTxEvent } from '../ledger/client.ts'
import { dec } from '../protocol/math.ts'
import { REASON_META_KEY, SENDER_META_KEY, TX_KIND_META_KEY } from './profiles.ts'

const HOLDING_SUFFIX = ':Splice.Api.Token.HoldingV1:Holding'
const INSTRUCTION_SUFFIX = ':Splice.Api.Token.TransferInstructionV1:TransferInstruction'

export interface IncomingTransfer {
  depositRef: string
  nodeId: number
  /** memo as received, not normalized */
  reason: string | null
  sender: string | null
  instrument: Instrument
  /** total of custodian holdings created by the transfer */
  amount: string
  holdingCids: string[]
}

export interface ReturnedTransfer {
  instructionCid: string
  nodeId: number
  choice: string
}

interface HoldingView {
  owner?: string
  instrumentId?: Instrument
  amount?: string
  lock?: unknown
}

/** A node of our protocol: its subtree of holdings is already accounted for. */
export function isOwnChoice(e: NonNullable<LedgerTxEvent['ExercisedEvent']>): boolean {
  return /:Lending\./.test(e.templateId) || e.choice.startsWith('BridgeUserAgreement_')
}

const metaOf = (result: unknown): Record<string, string> => {
  const v = (result as { meta?: { values?: unknown } } | null)?.meta?.values
  return v && typeof v === 'object' ? (v as Record<string, string>) : {}
}

const holdingViewOf = (e: NonNullable<LedgerTxEvent['CreatedEvent']>): HoldingView | null => {
  const views = e.interfaceViews ?? []
  const v = views.find((x) => !x.interfaceId || x.interfaceId.endsWith(HOLDING_SUFFIX))
  const view = (v?.viewValue ?? null) as HoldingView | null
  return view && typeof view.owner === 'string' && view.instrumentId && view.amount ? view : null
}

const isInstruction = (e: NonNullable<LedgerTxEvent['ExercisedEvent']>) =>
  !!e.interfaceId?.endsWith(INSTRUCTION_SUFFIX) ||
  !!e.implementedInterfaces?.some((i) => i.endsWith(INSTRUCTION_SUFFIX)) ||
  /^TransferInstruction_(Reject|Withdraw|Accept)$/.test(e.choice)

const failedOutput = (result: unknown) =>
  (result as { output?: { tag?: string } } | null)?.output?.tag ===
  'TransferInstructionResult_Failed'

const nodeOf = (e: LedgerTxEvent) =>
  e.CreatedEvent?.nodeId ?? e.ExercisedEvent?.nodeId ?? e.ArchivedEvent?.nodeId ?? 0

export function parseCustodyTransaction(
  tx: LedgerTransaction,
  custody: string,
): { incoming: IncomingTransfer[]; returned: ReturnedTransfer[] } {
  const events = [...tx.events].sort((a, b) => nodeOf(a) - nodeOf(b))
  const incoming: IncomingTransfer[] = []
  const returned: ReturnedTransfer[] = []
  let skipUntil = -1
  for (const ev of events) {
    const e = ev.ExercisedEvent
    if (!e || e.nodeId <= skipUntil) continue
    if (isOwnChoice(e)) {
      skipUntil = e.lastDescendantNodeId
      continue
    }
    if (e.consuming && isInstruction(e) && failedOutput(e.exerciseResult)) {
      returned.push({ instructionCid: e.contractId, nodeId: e.nodeId, choice: e.choice })
      skipUntil = e.lastDescendantNodeId
      continue
    }
    const meta = metaOf(e.exerciseResult)
    if (meta[TX_KIND_META_KEY] !== 'transfer') continue
    skipUntil = e.lastDescendantNodeId
    const arg = (e.choiceArgument ?? {}) as { sender?: unknown; description?: unknown }
    const sender =
      meta[SENDER_META_KEY] ?? (typeof arg.sender === 'string' ? arg.sender : null) ?? null
    // own withdrawal: custodian holdings in the subtree are change
    if (sender === custody) continue
    const reason =
      meta[REASON_META_KEY] ?? (typeof arg.description === 'string' ? arg.description : null)
    const created = events
      .map((x) => x.CreatedEvent)
      .filter(
        (c): c is NonNullable<LedgerTxEvent['CreatedEvent']> =>
          !!c && c.nodeId > e.nodeId && c.nodeId <= e.lastDescendantNodeId,
      )
      .map((c) => ({ c, view: holdingViewOf(c) }))
      .filter(({ view }) => view && view.owner === custody && !view.lock)
    const byInstrument = new Map<string, IncomingTransfer>()
    for (const { c, view } of created) {
      const i = view!.instrumentId!
      const key = `${i.admin}|${i.id}`
      const prev = byInstrument.get(key)
      if (prev) {
        prev.amount = dec(prev.amount).plus(view!.amount!).toFixed()
        prev.holdingCids.push(c.contractId)
      } else
        byInstrument.set(key, {
          depositRef: `${tx.updateId}:${e.nodeId}`,
          nodeId: e.nodeId,
          reason: reason ?? null,
          sender,
          instrument: { admin: i.admin, id: i.id },
          amount: dec(view!.amount!).toFixed(),
          holdingCids: [c.contractId],
        })
    }
    // One transfer, one instrument; several get different refs so amounts are not merged
    const list = [...byInstrument.values()]
    list.forEach((x, n) => {
      if (n > 0) x.depositRef = `${tx.updateId}:${e.nodeId}.${n}`
      incoming.push(x)
    })
  }
  return { incoming, returned }
}
