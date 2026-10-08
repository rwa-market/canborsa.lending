/**
 * History indexer (T3.1.7, Б7): reads the updates stream on behalf of the operator and stores
 * executed operations by Compound's names (Supply, Withdraw, SupplyCollateral, WithdrawCollateral,
 * Absorb, BuyCollateral, reserves). Idempotent: key (updateId, nodeId) and a checkpoint offset.
 *
 * The amount is the executed one, not the requested one (follow-up audit L4): "withdraw all" and
 * "repay all" transfer exactly the deposit or debt. So the amount is taken from the
 * TransferFactory_Transfer inside the choice. The debt part of a supply or withdraw and the absorb
 * figures come from the account before and after and the pool created by the transaction (its
 * indices are already accrued); the indexer keeps the previous states itself.
 */
import type { HistoryEntry, HistoryOp, MarketId as SharedMarketId } from '@lending/shared'
import { desc, eq } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/client.ts'
import { accountState, indexerGap, ledgerCheckpoint, operationHistory } from '../db/schema.ts'
import type { Metrics } from '../metrics.ts'
import type { Deployment } from '../deployment.ts'
import type { LedgerClient } from '../ledger/client.ts'
import { INTERFACES, TEMPLATES } from '../ledger/ids.ts'
import { dec, type Dec, money, moneyUp } from '../protocol/math.ts'
import type { AccountPayload, PoolPayload } from '../protocol/types.ts'

/** v3: the Compound V3 model in lending-core-v2; a new stream rereads the ledger from scratch. */
const STREAM = 'operation-history-v3'

/** The pool's last state in account_state, next to the accounts. */
export const POOL_STATE_KEY = '__pool__'

/** History operations (shared HistoryEntry.op): an unlisted DB string never reaches the API. */
const HISTORY_OPS = new Set<string>([
  'supply',
  'withdraw',
  'deposit-collateral',
  'withdraw-collateral',
  'absorb',
  'buy-collateral',
  'add-reserves',
  'withdraw-reserves',
  'open-account',
] satisfies HistoryOp[])

type Flow = 'in' | 'out' | null

/** Choice → operation, who the party is and the transfer direction relative to it. */
const USER_OPS: Record<string, { op: HistoryOp; flow: Flow; party: string }> = {
  Directory_Open: { op: 'open-account', flow: null, party: 'user' },
  Pool_SupplyBase: { op: 'supply', flow: 'out', party: 'user' },
  Pool_WithdrawBase: { op: 'withdraw', flow: 'in', party: 'user' },
  Pool_SupplyCollateral: { op: 'deposit-collateral', flow: 'out', party: 'user' },
  Pool_WithdrawCollateral: { op: 'withdraw-collateral', flow: 'in', party: 'user' },
  Pool_BuyCollateral: { op: 'buy-collateral', flow: 'out', party: 'buyer' },
  Pool_AddReserves: { op: 'add-reserves', flow: 'out', party: 'actor' },
  Pool_WithdrawReserves: { op: 'withdraw-reserves', flow: 'in', party: 'treasury' },
}

interface Exercised {
  nodeId: number
  lastDescendantNodeId?: number
  templateId?: string
  consuming?: boolean
  choice: string
  choiceArgument: Record<string, unknown>
}
interface Created {
  nodeId?: number
  templateId: string
  createArgument: Record<string, unknown>
}
interface TxEvent {
  ExercisedEvent?: Exercised
  CreatedEvent?: Created
}
export interface Tx {
  updateId: string
  offset: number
  effectiveAt: string
  events: TxEvent[]
}

interface Transfer {
  nodeId: number
  sender: string
  receiver: string
  amount: string
}

export interface HistoryRow {
  updateId: string
  nodeId: number
  offset: number
  effectiveAt: string
  party: string
  op: HistoryOp
  marketId: string | null
  amount: string | null
  seized: string | null
  credited: string | null
  collateralTaken: string | null
  debtPart: string | null
}

const isAccount = (c: Created | undefined) => !!c?.templateId.endsWith(':Lending.Account:Account')
const isPool = (c: Created | undefined) => !!c?.templateId.endsWith(':Lending.Pool:Pool')

/**
 * Whose account it is, which is how history is addressed: `loop:<party>` for a Loop account
 * (ADR-006; the same key as the Loop session), an EVM address (ADR-004) or the owner party.
 */
export const accountKey = (a: {
  owner?: unknown
  evmAddress?: unknown
  loopParty?: unknown
}): string | undefined =>
  typeof a.loopParty === 'string' && a.loopParty
    ? `loop:${a.loopParty}`
    : typeof a.evmAddress === 'string' && a.evmAddress
      ? a.evmAddress
      : typeof a.owner === 'string'
        ? a.owner
        : undefined

/** Custodial wallet operations by EvmAction tag: EVM and Loop. */
const WALLET_EXECUTE = new Set([
  'Pool_EvmExecute',
  'Pool_EvmWalletExecute',
  'Pool_LoopWalletExecute',
])

/** Wallet operations: EvmAction tag → operation and direction relative to the custodian. */
const EVM_OPS: Record<string, { op: HistoryOp; flow: Flow }> = {
  EvmSupply: { op: 'supply', flow: 'out' },
  EvmWithdraw: { op: 'withdraw', flow: 'in' },
  EvmBorrow: { op: 'withdraw', flow: 'in' },
  EvmDepositCollateral: { op: 'deposit-collateral', flow: 'out' },
  EvmWithdrawCollateral: { op: 'withdraw-collateral', flow: 'in' },
}

/** Token factory transfers in a transaction: who, to whom, how much. */
function transfers(tx: Tx): Transfer[] {
  return tx.events.flatMap((e) => {
    const ex = e.ExercisedEvent
    if (ex?.choice !== 'TransferFactory_Transfer') return []
    const t = ex.choiceArgument.transfer as
      { sender?: string; receiver?: string; amount?: string } | undefined
    if (!t?.sender || !t.receiver || !t.amount) return []
    return [{ nodeId: ex.nodeId, sender: t.sender, receiver: t.receiver, amount: t.amount }]
  })
}

/** Descendant nodes of a choice: (nodeId, lastDescendantNodeId]. */
const within = (ex: Exercised, nodeId: number) =>
  nodeId > ex.nodeId && nodeId <= (ex.lastDescendantNodeId ?? Number.MAX_SAFE_INTEGER)

/** Amount at token precision (10 decimals): 0.0413903102, not 0.041390310200000000. */
const tokenAmount = (v: string) => money(dec(v))

/** Signed USDCx balance of a principal at the pool's indices. */
const balanceAt = (principal: string | undefined, pool: PoolPayload | undefined): Dec | null => {
  if (principal === undefined || !pool) return null
  const p = dec(principal)
  return p.gte(0) ? p.mul(pool.state.supplyIndex) : p.mul(pool.state.borrowIndex)
}
const debtOf = (b: Dec) => (b.lt(0) ? b.neg() : dec(0))

const collateralMap = (a: AccountPayload | undefined) =>
  new Map((a?.collateral ?? []).map(([k, v]) => [k, dec(v)]))

/**
 * Operations of one transaction. The account owner comes from the created Account.
 * `previous(key)` is the stored state before the transaction: an account by owner key, the pool by
 * POOL_STATE_KEY.
 */
export function extractOperations(
  tx: Tx,
  previous: (key: string) => AccountPayload | PoolPayload | undefined = () => undefined,
): HistoryRow[] {
  const created = tx.events.map((e) => e.CreatedEvent).find(isAccount)
  const after = created?.createArgument as unknown as AccountPayload | undefined
  const accountOwner = created ? accountKey(created.createArgument) : undefined
  const pool = tx.events.map((e) => e.CreatedEvent).find(isPool)?.createArgument as unknown as
    PoolPayload | undefined
  const before = accountOwner ? (previous(accountOwner) as AccountPayload | undefined) : undefined
  const poolBefore = previous(POOL_STATE_KEY) as PoolPayload | undefined
  const moves = transfers(tx)
  // The account's state before this transaction: unknown if it existed before the indexer's
  // history (pruned offset) and the transaction updated it, as opposed to opening it
  const updatedExisting = tx.events.some(
    (e) =>
      e.ExercisedEvent?.consuming === true &&
      !!e.ExercisedEvent.templateId?.endsWith(':Lending.Account:Account'),
  )
  const debtChange = () => {
    if (!before && updatedExisting) return null
    const b = balanceAt(before?.principal ?? '0', pool)
    const a = balanceAt(after?.principal, pool)
    return b && a ? debtOf(b).minus(debtOf(a)) : null
  }
  return tx.events.flatMap((e): HistoryRow[] => {
    const ex = e.ExercisedEvent
    if (!ex) return []
    const arg = ex.choiceArgument
    const marketId = (arg.marketId as string | undefined) ?? null
    const base = {
      updateId: tx.updateId,
      nodeId: ex.nodeId,
      offset: tx.offset,
      effectiveAt: tx.effectiveAt,
      marketId,
      seized: null,
      credited: null,
      collateralTaken: null,
      debtPart: null,
    }
    /** Supply repaid this much debt; a withdraw borrowed this much. */
    const debtPartFor = (op: HistoryOp): string | null => {
      const change = debtChange()
      if (!change) return null
      const part = op === 'supply' ? change : op === 'withdraw' ? change.neg() : dec(0)
      return part.gt(0) ? money(part) : null
    }
    // Custodial wallets (EVM, Loop): the user is the account key, the custodian moves the tokens
    const action = arg.action as { tag?: string; value?: Record<string, unknown> } | undefined
    const evmOp = WALLET_EXECUTE.has(ex.choice)
      ? EVM_OPS[action?.tag ?? '']
      : ex.choice === 'EvmDirectory_Open' || ex.choice === 'LoopDirectory_Open'
        ? { op: 'open-account' as const, flow: null }
        : undefined
    if (evmOp) {
      const custody = String(arg.custody ?? created?.createArgument.owner ?? '')
      const party =
        ex.choice === 'EvmDirectory_Open'
          ? String(arg.address ?? '')
          : ex.choice === 'LoopDirectory_Open'
            ? arg.party
              ? `loop:${String(arg.party)}`
              : ''
            : (accountOwner ?? '')
      if (!party) return []
      const moved = moves.find(
        (t) =>
          within(ex, t.nodeId) &&
          (evmOp.flow === 'out' ? t.sender === custody : t.receiver === custody),
      )
      const requested = (action?.value?.amount as string | undefined) ?? null
      return [
        {
          ...base,
          marketId: (action?.value?.marketId as string | undefined) ?? marketId,
          party,
          op: evmOp.op,
          amount: moved ? tokenAmount(moved.amount) : requested,
          debtPart: debtPartFor(evmOp.op),
        },
      ]
    }
    const userOp = USER_OPS[ex.choice]
    if (userOp) {
      const party = String(arg[userOp.party] ?? accountOwner ?? '')
      if (!party) return []
      const moved = moves.find(
        (t) =>
          within(ex, t.nodeId) &&
          (userOp.flow === 'out' ? t.sender === party : t.receiver === party),
      )
      const requested = (arg.amount as string | undefined) ?? null
      return [
        {
          ...base,
          party,
          op: userOp.op,
          // only operations without an amount have no transfer; the requested amount is a fallback
          amount: moved ? tokenAmount(moved.amount) : requested,
          debtPart: debtPartFor(userOp.op),
        },
      ]
    }
    if (ex.choice === 'Pool_Absorb' && accountOwner && pool) {
      // the debt as of the transaction (accrued indices of the new pool), the collateral taken from
      // the account before, the USDCx credited from the book value the pool gained
      const debt = balanceAt(before?.principal, pool)
      const taken = [...collateralMap(before)].filter(([, a]) => a.gt(0))
      const basisNow = new Map(pool.markets.map(([k, m]) => [k, dec(m.protocolCollateralBasis)]))
      const basisBefore = new Map(
        (poolBefore?.markets ?? []).map(([k, m]) => [k, dec(m.protocolCollateralBasis)]),
      )
      const credited = poolBefore
        ? taken.reduce(
            (sum, [m]) => sum.plus(basisNow.get(m) ?? 0).minus(basisBefore.get(m) ?? 0),
            dec(0),
          )
        : null
      return [
        {
          ...base,
          party: accountOwner,
          op: 'absorb',
          amount: debt ? money(debtOf(debt)) : null,
          credited: credited ? money(credited) : null,
          collateralTaken: JSON.stringify(
            taken.map(([m, a]) => ({ marketId: m, amount: money(a) })),
          ),
        },
      ]
    }
    return []
  })
}

/** Accounts and the pool created by the transaction: key → new state. */
export function statesCreated(tx: Tx): Map<string, AccountPayload | PoolPayload> {
  const out = new Map<string, AccountPayload | PoolPayload>()
  for (const e of tx.events) {
    const c = e.CreatedEvent
    if (isAccount(c)) {
      const payload = c!.createArgument as unknown as AccountPayload
      out.set(accountKey(payload) ?? payload.owner, payload)
    } else if (isPool(c)) out.set(POOL_STATE_KEY, c!.createArgument as unknown as PoolPayload)
  }
  return out
}

/**
 * A different ledger under the database: another participant or an offset past the ledger end
 * (ledger reset). Continuing is not allowed: history would get mixed or stall (B-11, A-19).
 */
export class IndexerIdentityError extends Error {}

export function createIndexer(
  ledger: LedgerClient,
  d: Deployment,
  db: Db,
  pageSize = 200,
  opts: { log?: FastifyBaseLogger; metrics?: Metrics; resetOnLedgerChange?: boolean } = {},
) {
  let participant: string | null = null
  let lastLag: number | null = null
  const reset = () =>
    db.transaction((t) => {
      t.delete(operationHistory).run()
      t.delete(accountState).run()
      t.delete(ledgerCheckpoint).where(eq(ledgerCheckpoint.stream, STREAM)).run()
    })

  const loadState = (key: string): AccountPayload | PoolPayload | undefined => {
    const row = db.select().from(accountState).where(eq(accountState.owner, key)).get()
    return row ? (JSON.parse(row.payload) as AccountPayload | PoolPayload) : undefined
  }

  /** Rows, account state and the cursor of one page in a single SQLite transaction. */
  function applyPage(txs: Tx[], offset: number): number {
    return db.transaction((t) => {
      let stored = 0
      for (const tx of txs) {
        const rows = extractOperations(tx, loadState)
        for (const row of rows) {
          // a replayed event writes the same values; old rows get the executed amount
          t.insert(operationHistory)
            .values(row)
            .onConflictDoUpdate({
              target: [operationHistory.updateId, operationHistory.nodeId],
              set: {
                amount: row.amount,
                credited: row.credited,
                collateralTaken: row.collateralTaken,
                debtPart: row.debtPart,
              },
            })
            .run()
        }
        stored += rows.length
        for (const [owner, payload] of statesCreated(tx)) {
          // B-11: only a later state; replaying an old page will not roll it back
          const known = t.select().from(accountState).where(eq(accountState.owner, owner)).get()
          if (known && known.offset >= tx.offset) continue
          const value = { owner, offset: tx.offset, payload: JSON.stringify(payload) }
          t.insert(accountState)
            .values(value)
            .onConflictDoUpdate({ target: accountState.owner, set: value })
            .run()
        }
      }
      const checkpoint = { offset, updatedAt: new Date(), participantId: participant }
      t.insert(ledgerCheckpoint)
        .values({ stream: STREAM, ...checkpoint })
        .onConflictDoUpdate({ target: ledgerCheckpoint.stream, set: checkpoint })
        .run()
      return stored
    })
  }

  const loadCheckpoint = () =>
    db.select().from(ledgerCheckpoint).where(eq(ledgerCheckpoint.stream, STREAM)).get()

  async function step(): Promise<number> {
    participant ??= await ledger.participantId()
    let saved = loadCheckpoint()
    // A new stream (new model): rows and states of the old one describe other contracts
    if (!saved) reset()
    const pruned = await ledger.prunedOffset()
    const end = await ledger.ledgerEnd()
    const changed =
      saved?.participantId && saved.participantId !== participant
        ? `participant changed: ${saved.participantId} -> ${participant}`
        : saved && saved.offset > end
          ? `checkpoint ${saved.offset} is beyond ledger end ${end} (ledger was reset)`
          : null
    if (changed) {
      if (!opts.resetOnLedgerChange)
        throw new IndexerIdentityError(
          `indexer database belongs to another ledger: ${changed}; move DATABASE_PATH away or set INDEXER_RESET_ON_LEDGER_CHANGE=true`,
        )
      opts.log?.error({ reason: changed }, 'indexer database reset: another ledger')
      reset()
      saved = undefined
    }
    // The node no longer serves history before the prune boundary: start from it. Protocol
    // operations after deployment come later; on a fresh node the boundary is zero. But if the
    // checkpoint was before the boundary, it is a gap: events between them are lost with no replay
    // (B-11).
    if (saved && saved.offset < pruned) {
      db.insert(indexerGap)
        .values({
          stream: STREAM,
          fromOffset: saved.offset,
          toOffset: pruned,
          detectedAt: new Date(),
        })
        .run()
      opts.metrics?.inc('indexer_prune_gaps_total', 'history gaps: node pruned past the checkpoint')
      opts.log?.error(
        { from: saved.offset, to: pruned },
        'indexer history gap: the node pruned events past the checkpoint',
      )
    }
    let from = Math.max(saved?.offset ?? 0, pruned)
    let stored = 0
    while (from < end) {
      // Account in the filter: the created account gives the owner on liquidation (audit S1);
      // TransferFactory: executed transfer amounts (L4)
      const page = await ledger.updates(
        d.operator,
        [TEMPLATES.pool, TEMPLATES.account, TEMPLATES.accountDirectory],
        from,
        end,
        pageSize,
        [INTERFACES.transferFactory],
      )
      // Cursor by the last element of the page; an empty page means we reached the end (audit S2)
      const next =
        page.count === 0 || page.lastOffset === null ? end : Math.max(from, page.lastOffset)
      stored += applyPage(page.transactions as Tx[], next)
      if (next === from) break
      from = next
    }
    // the cursor is already recorded even for an empty range: participant is saved right away
    if (!loadCheckpoint()?.participantId) applyPage([], from)
    lastLag = Math.max(0, end - from)
    opts.metrics?.gauge('indexer_lag_offsets', 'ledger end minus indexer checkpoint', lastLag)
    return stored
  }

  /** Party history in the shared HistoryEntry form (A-7). */
  function history(party: string, limit = 100): HistoryEntry[] {
    return db
      .select()
      .from(operationHistory)
      .where(eq(operationHistory.party, party))
      .orderBy(desc(operationHistory.offset))
      .limit(limit)
      .all()
      .flatMap((r) =>
        HISTORY_OPS.has(r.op)
          ? [
              {
                updateId: r.updateId,
                nodeId: r.nodeId,
                offset: r.offset,
                effectiveAt: r.effectiveAt,
                party: r.party,
                op: r.op as HistoryOp,
                marketId: (r.marketId as SharedMarketId | null) ?? null,
                amount: r.amount,
                credited: r.credited ?? null,
                collateralTaken: r.collateralTaken
                  ? (JSON.parse(r.collateralTaken) as {
                      marketId: SharedMarketId
                      amount: string
                    }[])
                  : null,
                debtPart: r.debtPart ?? null,
                // absorb: the debt is repaid out of the credit and the rest stays on the balance;
                // a shortfall is written off by the protocol and the balance is 0 (Pool_Absorb)
                ...(r.op === 'absorb' && r.credited && r.amount
                  ? (() => {
                      const rest = dec(r.credited).minus(r.amount)
                      return {
                        balanceAfter: money(rest.gt(0) ? rest : dec(0)),
                        writtenOff: rest.lt(0) ? moneyUp(rest.neg()) : null,
                      }
                    })()
                  : { balanceAfter: null, writtenOff: null }),
              },
            ]
          : [],
      )
  }

  const gaps = () => db.select().from(indexerGap).all()

  return { step, history, gaps, lag: () => lastLag }
}
