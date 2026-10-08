import type {
  AccountCommand,
  InstrumentId,
  MarketId,
  Operation,
  PreparedCommand,
} from '@lending/shared'
import { loopPartyOf } from '@lending/shared'
import {
  keepPreviousData,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  isBusy,
  isStale,
  type LoopPrepareInput,
  type OperationInput,
  queryKeys,
} from '@/lib/api'
import { mulRatio } from '@/lib/decimal'
import { explainError } from '@/lib/errors'
import { useWallet } from '@/wallet/context'
import { commandIdFor, intentKey, settle } from '@/wallet/intentId'
import { CommandRejected, type Intent } from '@/wallet/verify'

/**
 * The backend rereads roles from ProtocolConfig (guardian rotation): do not cache forever.
 * Without /config there is no Loop login and no faucet: until it arrives (the backend restarts on
 * deploy), ask again every 3 s instead of waiting for a page reload.
 */
export const useConfig = () =>
  useQuery({
    queryKey: queryKeys.config,
    queryFn: api.config,
    staleTime: 5 * 60_000,
    refetchInterval: (q) => (q.state.data ? false : 3_000),
  })

export const usePool = () =>
  useQuery({
    queryKey: queryKeys.pool,
    queryFn: api.pool,
    refetchInterval: 15_000,
    staleTime: 5_000,
  })

export function useAccount() {
  const { party, signedIn } = useWallet()
  return useQuery({
    queryKey: queryKeys.account(party),
    queryFn: () => api.account(party!),
    enabled: party !== null && signedIn,
    // while there is no account, the bot may open it any second
    refetchInterval: (q) => (q.state.data === null ? 2_000 : 10_000),
    staleTime: 3_000,
  })
}

/**
 * Operation preview (rule 8): before → after of the position, blockers and warnings from the backend.
 * `all`: withdraw all / repay all, `amount` is then the snapshot.
 */
export function usePreview(
  op: Operation,
  amount: string,
  all: boolean,
  marketId: MarketId | undefined,
  instrument: InstrumentId | undefined,
  enabled: boolean,
) {
  const wallet = useWallet()
  return useQuery({
    queryKey: ['preview', op, wallet.party, amount, all, marketId, instrument?.id ?? null],
    queryFn: async () => {
      const walletAmounts = instrument ? await wallet.walletAmounts(instrument) : undefined
      const input: OperationInput = {
        party: wallet.party!,
        amount,
        ...(all ? { all: true } : {}),
        ...(marketId ? { marketId } : {}),
        ...(walletAmounts ? { walletAmounts } : {}),
      }
      return api.preview(op, input)
    },
    enabled: enabled && wallet.party !== null && wallet.signedIn,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
    // The price changes every 30 s: the "after" risk must not go stale while the dialog is open (F-13)
    refetchInterval: enabled ? 15_000 : false,
  })
}

type Op = Operation | AccountCommand

const LABELS: Record<Op, string> = {
  'open-account': 'Account requested: it opens in a few seconds',
  supply: 'Supplied',
  repay: 'Repaid',
  withdraw: 'Withdrawn',
  borrow: 'Borrowed',
  'deposit-collateral': 'Collateral deposited',
  'withdraw-collateral': 'Collateral withdrawn',
}

export interface OperationVars {
  /** Decimal amount; with `all` the snapshot shown to the user */
  amount?: string
  /** Withdraw all / repay all (K2): the command carries `full: true` */
  all?: boolean
  marketId?: MarketId
  instrument?: InstrumentId
  /** Account snapshot at click time: bounds for "all" (F-11) */
  balance?: string
  debt?: string
  collateral?: string
}

/** User intent for checking the command (F-1). */
function intentOf(op: Op, v: OperationVars, inputs: string[] | undefined): Intent {
  const amount = v.amount ?? ''
  const marketId = v.marketId as MarketId
  const opt = <T extends object>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T
  switch (op) {
    case 'open-account':
      return { kind: 'open-account' }
    case 'supply':
      return opt({ kind: 'supply', amount, inputs })
    case 'repay':
      return opt({ kind: 'repay', amount: v.all ? MAX : amount, debt: v.debt, inputs })
    case 'withdraw':
      return opt({ kind: 'withdraw', amount: v.all ? MAX : amount, balance: v.balance })
    case 'borrow':
      return { kind: 'borrow', amount }
    case 'deposit-collateral':
      return opt({ kind: 'deposit-collateral', marketId, amount, inputs })
    case 'withdraw-collateral':
      return opt({ kind: 'withdraw-collateral', marketId, amount, collateral: v.collateral })
  }
}

/** Loop operation by EvmAction kind (K2): repay is a supply, "all" is `full`. */
function loopInput(op: Operation, v: OperationVars): LoopPrepareInput {
  const amount = v.amount ?? ''
  switch (op) {
    case 'supply':
      return { op: 'supply', amount, full: false }
    case 'repay':
      return { op: 'supply', amount, full: !!v.all }
    case 'withdraw':
      return { op: 'withdraw', amount, full: !!v.all }
    case 'borrow':
      return { op: 'borrow', amount }
    case 'deposit-collateral':
    case 'withdraw-collateral':
      return { op, marketId: v.marketId as MarketId, amount }
  }
}

/** How many holdings to cover: the amount; for "repay all", the debt with a margin. */
function inputTarget(op: Op, v: OperationVars): string | null {
  if (op === 'repay' && v.all && v.debt) return mulRatio(v.debt, 101n, 100n)
  if (v.amount) return v.amount
  return null
}

const MAX = 'max'

/**
 * Auto-retries on a stale command or a busy pool (T3.1.2, audit S5, F-6). Both wallets ask again on
 * every attempt: Loop opens its signing window, the node wallet its Confirm dialog (review 03.10,
 * item 18). So one retry, and the dialog says why it is back (review item 32).
 */
const MAX_ATTEMPTS = { node: 2, loop: 2 } as const

/** Why the wallet asks again: shown with the summary of the retry (node Confirm, Loop signing). */
export function retryReason(e: unknown): string {
  return isBusy(e)
    ? 'Second attempt: the pool was busy with another transaction. Check the operation and confirm again.'
    : 'Second attempt: the pool changed while you were confirming, so the command was rebuilt. Check it and confirm again.'
}

export const isUserRejection = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: unknown } | null)?.code
  return (
    code === 'USER_REJECTED' ||
    code === 4001 ||
    /user (rejected|cancell?ed|denied)|USER_REJECTED/i.test(msg)
  )
}

const isDuplicate = (e: unknown) =>
  e instanceof Error &&
  /DUPLICATE_COMMAND|duplicate command|already (been )?(executed|submitted)/i.test(e.message)

/**
 * Ambiguous failure: unknown whether the command executed (wallet timeout, connection drop,
 * the wallet did not confirm execution). Then the intent's commandId is kept for the retry.
 */
export function isAmbiguous(e: unknown): boolean {
  if (e instanceof CommandRejected || e instanceof ApiError) return false
  if (isUserRejection(e) || isStale(e) || isBusy(e) || isDuplicate(e)) return false
  return true
}

/**
 * Protocol operation. Calls for different markets run in parallel: `isPendingFor` tells
 * whether an operation is running for this market, so only its row is blocked.
 */
export function useOperation(op: Op) {
  const wallet = useWallet()
  const qc = useQueryClient()
  // all pending calls of this operation in the tab, not just the last mutate
  const pending = useMutationState({
    filters: { mutationKey: ['operation', op], status: 'pending' },
    select: (m) => (m.state.variables as OperationVars | undefined)?.marketId,
  })
  const mutation = useMutation({
    mutationKey: ['operation', op],
    mutationFn: async (input: OperationVars) => {
      const party = wallet.party
      const kind = wallet.kind
      if (!party || !kind) throw new Error('Connect a wallet first')
      const key = intentKey(party, op, {
        amount: input.amount ?? null,
        marketId: input.marketId ?? null,
        all: input.all ?? null,
      })
      // One commandId per intent: the ledger drops a duplicate if the previous attempt went through
      const commandId = commandIdFor(key)
      let retry: string | undefined
      const run = async () => {
        if (kind === 'loop') {
          // Loop account: the backend assembles the custodian command, the frontend checks the signing text
          if (op === 'open-account') throw new Error('A Loop account opens on sign-in')
          const p = await api.loopPrepare(loopPartyOf(party) ?? party, loopInput(op, input))
          await wallet.submitLoop(p, intentOf(op, input, undefined), retry)
          return
        }
        const inputHoldingCids = input.instrument
          ? await wallet.inputHoldings(input.instrument, inputTarget(op, input))
          : undefined
        const prepared: PreparedCommand = await api.prepare(op, {
          party,
          ...(input.amount ? { amount: input.amount } : {}),
          ...(input.all ? { all: true } : {}),
          ...(input.marketId ? { marketId: input.marketId } : {}),
          ...(inputHoldingCids ? { inputHoldingCids } : {}),
        })
        await wallet.submit(prepared, intentOf(op, input, inputHoldingCids), commandId, retry)
      }
      for (let attempt = 1; ; attempt++) {
        try {
          await run()
          settle(key, commandId, false)
          return
        } catch (e) {
          if (isDuplicate(e)) {
            // A previous attempt with this commandId already executed: this is success, not an error
            settle(key, commandId, false)
            return
          }
          if (attempt >= MAX_ATTEMPTS[kind] || !(isStale(e) || isBusy(e))) {
            settle(key, commandId, isAmbiguous(e))
            throw e
          }
          retry = retryReason(e)
          if (attempt === 1)
            toast.info(
              kind === 'loop'
                ? 'The pool changed while you were signing. Sign the updated operation in your wallet.'
                : 'The pool is busy, retrying your transaction',
            )
          // The pause grows and is random, so concurrent users spread out in time
          const base = Math.min(4_000, 250 * 2 ** attempt)
          await new Promise((r) => setTimeout(r, base * (0.5 + Math.random())))
        }
      }
    },
    onSuccess: () => {
      toast.success(LABELS[op])
      void qc.invalidateQueries({ queryKey: queryKeys.pool })
      void qc.invalidateQueries({ queryKey: queryKeys.account(wallet.party) })
      void qc.invalidateQueries({ queryKey: queryKeys.history(wallet.party) })
      void qc.invalidateQueries({ queryKey: queryKeys.wallet(wallet.party) })
      void qc.invalidateQueries({ queryKey: ['preview'] })
    },
    onError: (e) => notifyError(e),
  })
  return { ...mutation, isPendingFor: (marketId: MarketId) => pending.includes(marketId) }
}

/**
 * Sign a service command (guardian, treasury) with the same retry as user
 * operations: rebuild a stale command, wait for a busy pool. One commandId per
 * intent: the ledger drops a duplicate if the previous attempt went through (F-6).
 */
export async function submitWithRetry(
  wallet: Pick<ReturnType<typeof useWallet>, 'submit' | 'party' | 'kind'>,
  build: () => Promise<{ prepared: PreparedCommand; intent: Intent }>,
): Promise<void> {
  const max = MAX_ATTEMPTS[wallet.kind ?? 'node']
  let key: string | null = null
  let id: string | null = null
  let retry: string | undefined
  for (let attempt = 1; ; attempt++) {
    try {
      const { prepared, intent } = await build()
      key ??= intentKey(wallet.party ?? '', intent.kind, intent)
      id ??= commandIdFor(key)
      await wallet.submit(prepared, intent, id, retry)
      settle(key, id, false)
      return
    } catch (e) {
      if (key && id && isDuplicate(e)) {
        settle(key, id, false)
        return
      }
      if (attempt >= max || !(isStale(e) || isBusy(e))) {
        if (key && id) settle(key, id, isAmbiguous(e))
        throw e
      }
      retry = retryReason(e)
      const base = Math.min(4_000, 250 * 2 ** attempt)
      await new Promise((r) => setTimeout(r, base * (0.5 + Math.random())))
    }
  }
}

/** A wallet rejection is not a transaction error; "ledger rejected" does not land here. */
export function notifyError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  // Known protocol states (negative reserves, closed sales, oracle rotation): an explanation
  const known = explainError(msg, e instanceof ApiError ? e.code : null)
  if (known) toast.error(known)
  else if (isUserRejection(e)) toast.info('Signature cancelled')
  else if (isAmbiguous(e))
    toast.error(
      // Review 03.10, item 5: a Loop retry is a new signed operation with a new nonce, so a retry
      // after an operation that did go through runs it again. No promise: check first
      `${humanize(msg)}. It may still have gone through: check your balance and History in a minute before trying again.`,
    )
  else toast.error(humanize(msg))
}

/** Human-readable error text: first letter capitalised, no technical prefix. */
export function humanize(msg: string): string {
  const known = explainError(msg)
  if (known) return known
  const text = msg.replace(/^(STALE_CONTRACT|BUSY):\s*/, '')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
