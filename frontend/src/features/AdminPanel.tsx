import type { PreparedCommand } from '@lending/shared'
import { PauseIcon, PlayIcon, UsersThreeIcon, WarningIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Panel, SectionTitle } from '@/components/brand'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { notifyError, submitWithRetry, useConfig, usePool } from '@/hooks/data'
import { api, queryKeys } from '@/lib/api'
import { formatAmount, isNegative } from '@/lib/amount'
import { cn } from '@/lib/utils'
import { useWallet } from '@/wallet/context'
import { type Intent, PAUSE_FLAGS, PAUSE_LABELS } from '@/wallet/verify'

type Flag = (typeof PAUSE_FLAGS)[number]

/** What each flag stops, in words: none of them blocks supply or repayment (§11). */
const PAUSE_NOTES: Record<Flag, string> = {
  borrowPaused: 'Borrow',
  collateralWithdrawPaused: 'Withdraw collateral',
  supplyWithdrawPaused: 'Withdraw USDCx supply',
  absorbPaused: 'Absorb liquidatable positions',
  buyPaused: 'Buy absorbed collateral',
}

/**
 * Guardian risk panel (K7): five pause flags in the PauseState contract, prices, reserves.
 * Supply, repayments and collateral deposits are never paused.
 */
export function AdminPanel() {
  const wallet = useWallet()
  const config = useConfig()
  const pool = usePool()
  const qc = useQueryClient()
  const act = useMutation({
    mutationFn: (build: () => Promise<{ prepared: PreparedCommand; intent: Intent }>) =>
      submitWithRetry(wallet, build),
    // The mutation waits for the pool refetch: before it, the next toggle would take a stale snapshot (F-9)
    onSuccess: async () => {
      toast.success('Updated on ledger')
      await qc.invalidateQueries({ queryKey: queryKeys.pool })
    },
    onError: (e) => notifyError(e),
  })
  /** Set one flag (PauseState_SetFlag): the other four are not in the command at all (1.0.2). */
  const set = (flag: Flag, paused: boolean) =>
    act.mutate(async () => ({
      prepared: await api.preparePause(wallet.party!, flag, paused),
      intent: { kind: 'pause', flag, paused },
    }))

  if (!wallet.signedIn || !config.data || wallet.party !== config.data.roles.guardian) return null
  // Without the pool state the guardian keeps the controls: in an incident they matter most
  if (!pool.data)
    return (
      <Panel aria-label="Risk admin" aria-busy={act.isPending}>
        <SectionTitle
          title="Risk admin"
          hint="Guardian pauses. Supply, repayments and collateral deposits are never paused."
        />
        <Alert variant="warning">
          <WarningIcon weight="fill" />
          <AlertDescription>
            {pool.isPending
              ? 'Loading the current pauses…'
              : 'The current pauses are unavailable. You can still pause or resume each action: the command changes only that one.'}
          </AlertDescription>
        </Alert>
        <ul aria-label="Pauses" className="divide-y divide-border rounded-lg border px-3">
          {PAUSE_FLAGS.map((flag) => (
            <li key={flag} className="flex flex-wrap items-center gap-2 py-2.5">
              <p className="mr-auto text-sm font-medium">{PAUSE_LABELS[flag]}</p>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() => set(flag, true)}
              >
                <PauseIcon weight="fill" /> Pause
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() => set(flag, false)}
              >
                <PlayIcon weight="fill" /> Resume
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
    )
  const p = pool.data
  const funds: [string, string][] = [
    ['Reserves', p.reserves],
    ['Net reserves', p.netReserves],
    ['Pool cash', p.cash],
  ]
  return (
    <Panel aria-label="Risk admin" aria-busy={act.isPending}>
      <SectionTitle
        title="Risk admin"
        hint="Guardian pauses. Supply, repayments and collateral deposits are never paused."
      />

      <ul aria-label="Pauses" className="divide-y divide-border rounded-lg border px-3">
        {PAUSE_FLAGS.map((flag) => {
          const paused = p.pauses[flag]
          return (
            <li key={flag} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="mr-auto min-w-0">
                <p className="text-sm font-medium">{PAUSE_LABELS[flag]}</p>
                <p className="text-xs text-muted-foreground">{PAUSE_NOTES[flag]}</p>
              </div>
              <Badge variant={paused ? 'warning' : 'success'}>{paused ? 'Paused' : 'Open'}</Badge>
              <Button
                size="sm"
                className="w-24"
                variant={paused ? 'default' : 'outline'}
                disabled={act.isPending}
                aria-label={`${paused ? 'Resume' : 'Pause'} ${PAUSE_LABELS[flag].toLowerCase()}`}
                onClick={() => set(flag, !paused)}
              >
                {paused ? <PlayIcon weight="fill" /> : <PauseIcon weight="fill" />}
                {paused ? 'Resume' : 'Pause'}
              </Button>
            </li>
          )
        })}
      </ul>

      {/* Funds and prices as "label left, value right" lists: a narrow column does not break them */}
      <div className="flex flex-col gap-3">
        <dl className="divide-y divide-border rounded-lg bg-muted/60 px-4 text-sm">
          {funds.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 py-2.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd
                className={cn(
                  'font-semibold whitespace-nowrap',
                  isNegative(value) && 'text-destructive',
                )}
              >
                {formatAmount(value)}{' '}
                <span className="text-xs font-medium text-muted-foreground">USDCx</span>
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-1.5">
          <p className="px-1 text-xs font-medium text-muted-foreground">Oracle prices</p>
          <dl className="divide-y divide-border rounded-lg border px-4 text-sm">
            {Object.entries(p.prices).map(([symbol, price]) => {
              const ok = !!price && price.valid
              return (
                <div key={symbol} className="flex items-center justify-between gap-3 py-2.5">
                  <dt className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn('size-1.5 rounded-full', ok ? 'bg-success' : 'bg-destructive')}
                    />
                    {symbol}
                  </dt>
                  <dd
                    className={cn(
                      'text-right',
                      ok ? 'text-muted-foreground' : 'font-medium text-destructive',
                    )}
                  >
                    {price
                      ? `${price.ageSeconds}s ago${price.valid ? '' : `, stale (${price.reason})`}`
                      : 'No feed'}
                  </dd>
                </div>
              )
            })}
          </dl>
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <UsersThreeIcon size={14} weight="bold" />
        Parameters:{' '}
        {p.governed ? `governance council of ${p.councilSize}` : 'operator (no council yet)'}
      </p>
    </Panel>
  )
}
