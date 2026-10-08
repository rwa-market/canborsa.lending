import { WarningOctagonIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useAccount } from '@/hooks/data'
import { api, queryKeys } from '@/lib/api'
import { formatAmount, isNegative, isZero } from '@/lib/amount'
import { formatDateTime } from '@/lib/dates'
import { tokenDigits } from '@/lib/tokens'
import { useWallet } from '@/wallet/context'

/** How long after an absorb the dashboard explains it. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000
/** After the account changes shape, ask for the history this often for this long. */
const BURST_MS = 2_000
const BURST_FOR_MS = 30_000
const seenKey = (updateId: string) => `lending-absorb-seen-${updateId}`

function seen(updateId: string) {
  try {
    return localStorage.getItem(seenKey(updateId)) === '1'
  } catch {
    return false
  }
}

/**
 * After an absorb the user learns what happened on the dashboard, not only from the history
 * (review 03.10, item 6): the collateral taken, the debt repaid from it and what stays on the
 * balance. The numbers come from the backend history as they are.
 */
export function AbsorbNotice() {
  const { party, signedIn } = useWallet()
  const qc = useQueryClient()
  const account = useAccount()
  const burstUntil = useRef(0)
  const history = useQuery({
    queryKey: queryKeys.history(party),
    queryFn: () => api.history(party!),
    enabled: party !== null && signedIn,
    refetchInterval: () => (Date.now() < burstUntil.current ? BURST_MS : 15_000),
  })
  // Review item 30: the account refreshes faster than the history, so the collateral vanished and
  // the explanation came up to 20 s later. A debt that turned into a deposit or collateral gone to
  // zero is how an absorb looks on the account: ask for the history at once and keep asking for a while
  const shape = account.data
    ? `${isNegative(account.data.summary.balance)}|${account.data.collateral.every((c) => isZero(c.amount))}`
    : null
  const lastShape = useRef<string | null>(null)
  useEffect(() => {
    if (shape === null) return
    const before = lastShape.current
    lastShape.current = shape
    if (before === null || before === shape) return
    burstUntil.current = Date.now() + BURST_FOR_MS
    void qc.invalidateQueries({ queryKey: queryKeys.history(party) })
  }, [shape, party, qc])
  const [dismissed, setDismissed] = useState<string | null>(null)
  // the page's opening time is precise enough for a 7-day window, and render stays pure
  const [openedAt] = useState(() => Date.now())
  const last = history.data?.find((e) => e.op === 'absorb')
  if (!last || dismissed === last.updateId || seen(last.updateId)) return null
  if (openedAt - Date.parse(last.effectiveAt) > RECENT_MS) return null
  const taken = (last.collateralTaken ?? [])
    .map((c) => `${formatAmount(c.amount, tokenDigits(c.marketId))} ${c.marketId}`)
    .join(' and ')
  const after = last.balanceAfter
  return (
    <Alert variant="destructive" className="rounded-xl p-4">
      <WarningOctagonIcon weight="fill" />
      <AlertTitle className="font-semibold">
        Your position was liquidated on {formatDateTime(last.effectiveAt)}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>
          Your debt passed the liquidation point, so the protocol took your collateral
          {taken ? ` (${taken})` : ''} and repaid your {formatAmount(last.amount, 4)} USDCx debt
          from it.
          {last.writtenOff
            ? ` The collateral did not cover ${formatAmount(last.writtenOff, 4)} USDCx of it: the protocol wrote that off, and your balance is 0. You owe nothing.`
            : after && !isZero(after)
              ? ` The rest, ${formatAmount(after, 4)} USDCx, stays on your balance as a deposit: you can withdraw it.`
              : ''}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link to="/history">See the history</Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              try {
                localStorage.setItem(seenKey(last.updateId), '1')
              } catch {
                // private mode: the notice just hides for this page view
              }
              setDismissed(last.updateId)
            }}
          >
            Got it
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
