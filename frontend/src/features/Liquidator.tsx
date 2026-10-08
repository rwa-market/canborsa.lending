import type { BuyerView, CollateralSaleView } from '@lending/shared'
import { EyeSlashIcon, PauseCircleIcon, StorefrontIcon, WarningIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useId, useState } from 'react'
import { toast } from 'sonner'
import { Panel, SectionTitle, TokenIcon } from '@/components/brand'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useNetworkBlocked } from '@/hooks/app'
import { notifyError, submitWithRetry, useConfig } from '@/hooks/data'
import { api, queryKeys } from '@/lib/api'
import {
  compareAmounts,
  formatAmount,
  formatPercent,
  formatUsd,
  isAmount,
  isZero,
} from '@/lib/amount'
import { tokenDigits } from '@/lib/tokens'
import { useWallet } from '@/wallet/context'

/** Exact decimal for an input: no trailing zeros. */
const exact = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v)

/**
 * One asset for sale: USDCx to pay, a quote from the backend (POST /buyer/quote), and the minimum
 * to receive. The contract rejects the purchase if the price moved and it would give less.
 */
function BuyForm({ c, view }: { c: CollateralSaleView; view: BuyerView }) {
  const uid = useId()
  const wallet = useWallet()
  const qc = useQueryClient()
  const { blocked, reason: networkReason } = useNetworkBlocked()
  const config = useConfig()
  const [amount, setAmount] = useState('')
  // null: the minimum follows the quote less the bots' tolerance (review item 29); a string: the
  // buyer typed their own
  const [ownMin, setOwnMin] = useState<string | null>(null)
  const deferred = useDeferredValue(amount.trim())
  const valid = isAmount(deferred) && !isZero(deferred)
  const quote = useQuery({
    queryKey: ['buyer-quote', wallet.party, c.marketId, deferred],
    queryFn: () => api.buyerQuote({ party: wallet.party!, marketId: c.marketId, amount: deferred }),
    enabled: valid && !!wallet.party && view.forSale,
    staleTime: 5_000,
    refetchInterval: 15_000,
  })
  const minCollateral = ownMin ?? (quote.data ? exact(quote.data.minReceive) : '')
  const minValid = isAmount(minCollateral) && !isZero(minCollateral)
  const buy = useMutation({
    mutationFn: async () => {
      const party = wallet.party
      if (!party) throw new Error('Connect a wallet first')
      await submitWithRetry(wallet, async () => {
        // The wallet picks the USDCx holdings it spends; the verifier refuses any other inputs
        const inputs = config.data
          ? await wallet.inputHoldings(config.data.instruments.usdcx, deferred)
          : undefined
        const input = {
          party,
          marketId: c.marketId,
          amount: deferred,
          minCollateral,
          ...(inputs ? { inputHoldingCids: inputs } : {}),
        }
        return {
          prepared: await api.prepareBuy(input),
          intent: {
            kind: 'buy-collateral',
            marketId: c.marketId,
            amount: deferred,
            minCollateral,
            ...(inputs ? { inputs } : {}),
          },
        }
      })
    },
    onSuccess: async () => {
      toast.success(`Bought ${c.marketId}`)
      setAmount('')
      setOwnMin(null)
      await qc.invalidateQueries({ queryKey: queryKeys.buyer(wallet.party) })
    },
    onError: (e) => notifyError(e),
  })
  const closed = !view.forSale || view.buyPaused || isZero(c.available)
  const short = valid && compareAmounts(deferred, view.wallet.USDCx) > 0
  const canBuy =
    !closed &&
    valid &&
    !short &&
    amount.trim() === deferred &&
    minValid &&
    !!quote.data &&
    !quote.isFetching &&
    !buy.isPending &&
    !blocked
  // Why Buy is unavailable, in words: never a silent block
  const why = buy.isPending
    ? 'Confirm the purchase in your wallet.'
    : blocked
      ? `Signing is blocked: ${networkReason ?? 'wrong network'}. Switch your wallet to the protocol network.`
      : view.buyPaused
        ? 'Collateral sales are paused by the guardian.'
        : !view.forSale
          ? 'Sales are closed: reserves are at the target.'
          : isZero(c.available)
            ? 'Nothing of this asset is for sale.'
            : !valid
              ? 'Enter the USDCx you pay.'
              : short
                ? `You hold ${formatAmount(view.wallet.USDCx)} USDCx, less than ${formatAmount(deferred)}.`
                : !minValid
                  ? 'Enter the minimum you accept to receive.'
                  : quote.isFetching || !quote.data
                    ? 'Getting a quote…'
                    : ''
  const digits = tokenDigits(c.marketId)
  return (
    <form
      aria-label={`Buy ${c.marketId}`}
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        if (canBuy) buy.mutate()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field className="gap-1.5">
          <FieldLabel htmlFor={`${uid}-pay`}>You pay, USDCx</FieldLabel>
          <Input
            id={`${uid}-pay`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            disabled={closed}
            onChange={(e) => {
              setAmount(e.target.value)
              setOwnMin(null)
            }}
          />
          {c.costOfAll && (
            <FieldDescription className="text-xs">
              Everything available costs {formatAmount(c.costOfAll)} USDCx
            </FieldDescription>
          )}
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor={`${uid}-min`}>Minimum to receive, {c.marketId}</FieldLabel>
          <Input
            id={`${uid}-min`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={minCollateral}
            disabled={closed}
            aria-describedby={`${uid}-min-hint`}
            onChange={(e) => setOwnMin(e.target.value.trim())}
          />
          <FieldDescription id={`${uid}-min-hint`} className="text-xs">
            Set below the quote, as the bots do, so a small price move does not reject the purchase.
            It is rejected if it would give less than this.
          </FieldDescription>
        </Field>
      </div>
      <p className="min-h-5 text-sm" role="status" aria-live="polite">
        {!valid ? (
          ''
        ) : quote.isError ? (
          <span className="text-destructive">No quote right now: {quote.error.message}</span>
        ) : quote.data ? (
          <>
            You receive{' '}
            <span className="font-semibold">
              {formatAmount(quote.data.receive, digits)} {c.marketId}
            </span>{' '}
            at {formatUsd(quote.data.price, 4)} per {c.marketId}
          </>
        ) : (
          <span className="text-muted-foreground">Getting a quote…</span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={!canBuy}
          aria-busy={buy.isPending}
          aria-describedby={`${uid}-why`}
        >
          {buy.isPending && <Spinner data-icon="inline-start" />}
          Buy {c.marketId}
        </Button>
        {c.costOfAll && !closed && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setAmount(exact(c.costOfAll!))
              setOwnMin(null)
            }}
          >
            Buy everything for {formatAmount(c.costOfAll)} USDCx
          </Button>
        )}
        {short && !closed && !isZero(view.wallet.USDCx) && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setAmount(exact(view.wallet.USDCx))
              setOwnMin(null)
            }}
          >
            Use all {formatAmount(view.wallet.USDCx)} USDCx
          </Button>
        )}
      </div>
      <p id={`${uid}-why`} role="status" className="min-h-4 text-xs text-muted-foreground">
        {why}
      </p>
    </form>
  )
}

/**
 * Liquidators and the backstop buy collateral the protocol absorbed (K5): at the oracle price
 * minus a discount, while reserves are below the target. They never see whose position it was.
 */
export function Liquidator() {
  const wallet = useWallet()
  const config = useConfig()
  const roles = config.data?.roles
  const buyers = roles ? [...(roles.liquidators ?? [roles.liquidator]), roles.backstop] : []
  const mine = wallet.signedIn && !!wallet.party && buyers.includes(wallet.party)
  const view = useQuery({
    queryKey: queryKeys.buyer(wallet.party),
    queryFn: () => api.buyer(wallet.party!),
    enabled: mine,
    refetchInterval: 10_000,
  })
  if (!mine) return null
  const v = view.data

  return (
    <Panel aria-label="Collateral for sale">
      <SectionTitle
        title="Collateral for sale"
        hint="When a position is liquidated, the protocol takes its collateral and sells it to approved buyers at a discount until reserves reach the target."
      />
      <Alert className="border-transparent bg-muted/60">
        <EyeSlashIcon weight="bold" />
        <AlertDescription>
          <p>You see what the protocol holds and its price. Whose position it was stays private.</p>
        </AlertDescription>
      </Alert>
      {view.isPending ? (
        <Skeleton className="h-24 w-full rounded-lg" label="Loading collateral for sale" />
      ) : view.isError ? (
        <Alert variant="destructive">
          <WarningIcon weight="fill" />
          <AlertDescription>Collateral for sale is unavailable.</AlertDescription>
        </Alert>
      ) : (
        <>
          <dl className="divide-y divide-border rounded-lg bg-muted/60 px-4 text-sm">
            {(
              [
                [
                  'Sale',
                  <Badge key="s" variant={v!.forSale ? 'success' : 'outline'}>
                    {v!.forSale ? 'Open: reserves below target' : 'Closed: reserves at target'}
                  </Badge>,
                ],
                ['Reserves', `${formatAmount(v!.reserves)} USDCx`],
                ['Target reserves', `${formatAmount(v!.targetReserves)} USDCx`],
                ['Your USDCx', formatAmount(v!.wallet.USDCx)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 py-2.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          {v!.buyPaused && (
            <Alert variant="warning">
              <PauseCircleIcon weight="fill" />
              <AlertDescription>Collateral sales are paused by the guardian.</AlertDescription>
            </Alert>
          )}
          {v!.collateral.every((c) => isZero(c.available)) ? (
            <Empty variant="outline" className="p-4 md:p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <StorefrontIcon />
                </EmptyMedia>
                <EmptyDescription>
                  The protocol holds no collateral for sale. It appears here after a position is
                  liquidated.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {v!.collateral.map((c) => (
                <Card asChild key={c.marketId} className="gap-4 rounded-lg p-4 shadow-none">
                  <li aria-label={`${c.marketId} for sale`}>
                    <div className="flex items-center gap-3">
                      <TokenIcon symbol={c.marketId} className="size-8" />
                      <span className="mr-auto font-semibold">{c.marketId}</span>
                      <Badge variant="info" className="px-2.5 py-1 font-semibold">
                        {formatPercent(c.discount, 1)} discount
                      </Badge>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                      {(
                        [
                          [
                            'Available',
                            `${formatAmount(c.available, tokenDigits(c.marketId))} ${c.marketId}`,
                          ],
                          ['Oracle price', c.marketPrice ? formatUsd(c.marketPrice, 4) : '—'],
                          ['Your price', c.price ? formatUsd(c.price, 4) : 'No valid price'],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <dt className="text-xs text-muted-foreground">{label}</dt>
                          <dd className="font-semibold break-words">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <BuyForm c={c} view={v!} />
                  </li>
                </Card>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  )
}
