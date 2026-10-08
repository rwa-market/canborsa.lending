import type { HistoryEntry } from '@lending/shared'
import {
  ArrowCircleUpIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  GavelIcon,
  type Icon,
  LockKeyOpenIcon,
  PiggyBankIcon,
  QuestionIcon,
  ShieldPlusIcon,
  StorefrontIcon,
  UserPlusIcon,
  VaultIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Panel, SectionTitle } from '@/components/brand'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { api, queryKeys } from '@/lib/api'
import { compareAmounts, formatAmount, isZero } from '@/lib/amount'
import { tokenDigits } from '@/lib/tokens'
import { formatDateTime } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useWallet } from '@/wallet/context'

const LABEL: Record<HistoryEntry['op'], string> = {
  'open-account': 'Opened account',
  supply: 'Supplied',
  withdraw: 'Withdrew',
  'deposit-collateral': 'Supplied collateral',
  'withdraw-collateral': 'Withdrew collateral',
  absorb: 'Liquidated',
  'buy-collateral': 'Bought collateral',
  'add-reserves': 'Added reserves',
  'withdraw-reserves': 'Withdrew reserves',
}

const ICON: Record<HistoryEntry['op'], [Icon, string]> = {
  'open-account': [UserPlusIcon, 'bg-primary/10 text-brand'],
  supply: [PiggyBankIcon, 'bg-primary/10 text-brand'],
  withdraw: [ArrowCircleUpIcon, 'bg-primary/10 text-brand'],
  'deposit-collateral': [ShieldPlusIcon, 'bg-primary/10 text-brand'],
  'withdraw-collateral': [LockKeyOpenIcon, 'bg-primary/10 text-brand'],
  absorb: [GavelIcon, 'bg-destructive/10 text-destructive'],
  'buy-collateral': [StorefrontIcon, 'bg-primary/10 text-brand'],
  'add-reserves': [VaultIcon, 'bg-success/10 text-success'],
  'withdraw-reserves': [VaultIcon, 'bg-muted text-muted-foreground'],
}

/** Both amounts as the row shows them: a dust difference from interest is not "the rest". */
const sameShown = (a: string, b: string | null) => formatAmount(a, 4) === formatAmount(b, 4)

/**
 * Name of a USDCx operation by its debt part (K2): a supply that went to the debt in full is a
 * repayment, "Repay all" with its interest dust included (review 08.10, item 6); one that also
 * left a deposit stays "Supplied" with the debt part below. A withdrawal that opened any debt is a
 * loan, as the user signed it (risk 7), even when part of it came from the deposit. Strings are
 * compared, not computed.
 */
function labelOf(e: HistoryEntry): string {
  const debt = e.debtPart && !isZero(e.debtPart) ? e.debtPart : null
  if (debt && e.op === 'withdraw') return 'Borrowed'
  if (debt && e.op === 'supply' && sameShown(debt, e.amount)) return 'Repaid'
  return LABEL[e.op] ?? e.op
}

/** Second line under the amount: the debt part, or what an absorb did. */
function details(e: HistoryEntry): string[] {
  if (e.op === 'absorb')
    return [
      ...(e.collateralTaken ?? []).map(
        (c) => `Collateral taken ${formatAmount(c.amount, tokenDigits(c.marketId))} ${c.marketId}`,
      ),
      ...(e.credited ? [`Credited ${formatAmount(e.credited, 4)} USDCx for it`] : []),
      // what the user actually has now: the debt came out of the credit
      ...(e.writtenOff
        ? [
            `The collateral did not cover ${formatAmount(e.writtenOff, 4)} USDCx of the debt: the protocol wrote it off; your balance is 0`,
          ]
        : e.balanceAfter && !isZero(e.balanceAfter)
          ? [`${formatAmount(e.balanceAfter, 4)} USDCx stays on your balance as a deposit`]
          : []),
    ]
  const debt = e.debtPart && !isZero(e.debtPart) ? e.debtPart : null
  if (!debt || (e.amount && compareAmounts(debt, e.amount) === 0)) return []
  if (e.op === 'supply')
    return sameShown(debt, e.amount)
      ? []
      : [`${formatAmount(debt, 4)} went to the debt, the rest was supplied and earns interest`]
  if (e.op === 'withdraw')
    return [`${formatAmount(debt, 4)} borrowed, the rest came from your deposit`]
  return []
}

/** A new operation type from the backend does not crash the page (F-19). */
const FALLBACK: [Icon, string] = [QuestionIcon, 'bg-muted text-muted-foreground']

/** Entries per history page. */
const PAGE_SIZE = 10

const unit = (e: HistoryEntry) =>
  e.op === 'deposit-collateral' || e.op === 'withdraw-collateral' ? (e.marketId ?? '') : 'USDCx'

/** Amount caption: for an absorb it is the debt written off. */
const amountOf = (e: HistoryEntry) =>
  e.op === 'absorb'
    ? `${formatAmount(e.amount, 4)} USDCx debt repaid from your collateral`
    : `${formatAmount(e.amount, 4)} ${unit(e)}`

export function History() {
  const { party, signedIn } = useWallet()
  const history = useQuery({
    queryKey: queryKeys.history(party),
    queryFn: () => api.history(party!),
    enabled: party !== null && signedIn,
    refetchInterval: 15_000,
  })
  const [page, setPage] = useState(0)
  const total = history.data?.length ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // the history may have shrunk (wallet change): do not stay on an empty page
  const current = Math.min(page, pages - 1)
  if (!party) return null
  const from = current * PAGE_SIZE
  return (
    <Panel aria-label="History">
      <SectionTitle title="History" />
      {history.isPending ? (
        <Skeleton label="Loading history…" className="h-40 w-full rounded-lg" />
      ) : history.isError ? (
        <Alert variant="destructive" className="flex flex-wrap items-center justify-between gap-2">
          <AlertDescription>History is unavailable right now.</AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : history.data.length === 0 ? (
        <Empty variant="outline" className="p-4 md:p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClockCounterClockwiseIcon />
            </EmptyMedia>
            <EmptyDescription>No operations yet.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol id="history-list" className="divide-y divide-border/70">
          {history.data.slice(from, from + PAGE_SIZE).map((e) => {
            const [I, tone] = ICON[e.op] ?? FALLBACK
            return (
              <li
                key={`${e.updateId}-${e.nodeId}`}
                className="-mx-2 flex animate-in items-center gap-3 rounded-lg px-2 py-2.5 transition-colors duration-200 fade-in hover:bg-muted/50"
                title={`update ${e.updateId}`}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg',
                    tone,
                  )}
                >
                  <I size={18} weight="bold" aria-hidden="true" />
                </span>
                <div className="mr-auto min-w-0">
                  <p className="text-sm font-semibold">
                    {labelOf(e)}
                    {e.marketId &&
                    e.op !== 'deposit-collateral' &&
                    e.op !== 'withdraw-collateral' &&
                    e.op !== 'absorb'
                      ? ` · ${e.marketId}`
                      : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <time dateTime={e.effectiveAt}>{formatDateTime(e.effectiveAt)}</time>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold whitespace-nowrap">
                    {e.amount ? amountOf(e) : <span aria-label="No amount">—</span>}
                  </p>
                  {details(e).map((d) => (
                    <p key={d} className="text-xs whitespace-nowrap text-muted-foreground">
                      {d}
                    </p>
                  ))}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {total > PAGE_SIZE && <Separator />}
      {total > PAGE_SIZE && (
        <nav aria-label="History pages" className="-mt-2 flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {from + 1}–{Math.min(from + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-controls="history-list"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <CaretLeftIcon weight="bold" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-controls="history-list"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              Next
              <CaretRightIcon weight="bold" />
            </Button>
          </div>
        </nav>
      )}
    </Panel>
  )
}
