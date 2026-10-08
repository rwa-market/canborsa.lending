import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Panel, SectionTitle, TokenIcon } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useFaucet } from '@/hooks/app'
import { notifyError, submitWithRetry, useConfig } from '@/hooks/data'
import { api, queryKeys } from '@/lib/api'
import { formatAmount, isAmount, isNegative, isZero } from '@/lib/amount'
import { tokenDigits } from '@/lib/tokens'
import { cn } from '@/lib/utils'
import { useWallet } from '@/wallet/context'

/**
 * Protocol reserves (K6): reserves = cash + debt − supply, net reserves add the book value of the
 * absorbed collateral. While net reserves are negative, loans and USDCx withdrawals are closed. The
 * treasury adds reserves (Pool_AddReserves); the guardian sees the same without actions.
 */
export function Treasury() {
  const wallet = useWallet()
  const config = useConfig()
  const qc = useQueryClient()
  const roles = config.data?.roles
  const isTreasury = !!roles && wallet.party === roles.treasury
  const visible = wallet.signedIn && !!roles && (isTreasury || wallet.party === roles.guardian)
  const view = useQuery({
    queryKey: queryKeys.treasury,
    queryFn: api.treasury,
    enabled: visible,
    refetchInterval: 10_000,
  })
  const [amount, setAmount] = useState('')
  const faucet = useFaucet()
  const add = useMutation({
    mutationFn: async (value: string) => {
      const party = wallet.party
      if (!party) throw new Error('Connect a wallet first')
      await submitWithRetry(wallet, async () => {
        // The wallet picks the holdings it spends; the verifier then refuses any other inputs
        const inputs = config.data
          ? await wallet.inputHoldings(config.data.instruments.usdcx, value)
          : undefined
        return {
          prepared: await api.prepareAddReserves(party, value, inputs),
          intent: { kind: 'add-reserves', amount: value, ...(inputs ? { inputs } : {}) },
        }
      })
    },
    onSuccess: async () => {
      toast.success('Reserves added')
      setAmount('')
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.treasury }),
        qc.invalidateQueries({ queryKey: queryKeys.pool }),
      ])
    },
    onError: (e) => notifyError(e),
  })
  if (!visible) return null
  const t = view.data
  const validAmount = isAmount(amount) && !isZero(amount)

  return (
    <Panel aria-label="Treasury" aria-busy={add.isPending}>
      <SectionTitle
        title="Reserves"
        hint={
          isTreasury
            ? 'Reserves absorb bad debt before suppliers. Add USDCx when net reserves are low or negative.'
            : 'Protocol reserves and absorbed collateral. The treasury adds reserves.'
        }
      />
      {!t ? (
        <Skeleton className="h-40 w-full rounded-lg" label="Loading reserves" />
      ) : (
        <>
          <dl className="divide-y divide-border rounded-lg bg-muted/60 px-4 text-sm">
            {(
              [
                ['Reserves', t.reserves],
                ['Net reserves', t.netReserves],
                ['Target reserves', t.targetReserves],
                ['Pool cash', t.cash],
                ['Treasury wallet', t.treasuryUsdcx],
                ['Backstop wallet', t.backstopUsdcx],
              ] as const
            ).map(([label, value]) => (
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
          {isNegative(t.netReserves) && (
            <p className="text-sm text-destructive">
              Net reserves are negative: loans and USDCx withdrawals are closed until reserves are
              added.
            </p>
          )}

          {isTreasury && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (validAmount && !add.isPending) add.mutate(amount)
              }}
            >
              <Field className="gap-2">
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel htmlFor="reserves-amount">Add reserves, USDCx</FieldLabel>
                  {/* Test network: treasury has no USDCx, the faucet gives them the same way as to a user */}
                  {config.data?.testFaucet && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label="Get test USDCx"
                      disabled={faucet.isPendingFor('USDCx')}
                      aria-busy={faucet.isPendingFor('USDCx')}
                      onClick={() => faucet.mutate('USDCx')}
                    >
                      {faucet.isPendingFor('USDCx') && <Spinner data-icon="inline-start" />}
                      Faucet
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    id="reserves-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.trim())}
                  />
                  <Button type="submit" disabled={!validAmount || add.isPending}>
                    {add.isPending && <Spinner data-icon="inline-start" />}
                    Add reserves
                  </Button>
                </div>
              </Field>
            </form>
          )}

          <div className="flex flex-col gap-1.5">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              Absorbed collateral held by the protocol
            </p>
            <ul className="divide-y divide-border rounded-lg border px-4 text-sm">
              {t.collateralBook.map((c) => (
                <li
                  key={c.marketId}
                  aria-label={`${c.marketId} held by the protocol`}
                  className="flex items-center gap-3 py-2.5"
                >
                  <TokenIcon symbol={c.marketId} className="size-6" />
                  <span className="mr-auto font-medium">
                    {formatAmount(c.amount, tokenDigits(c.marketId))} {c.marketId}
                  </span>
                  <span className="text-right">
                    <span className="font-semibold">{formatAmount(c.basis)} USDCx</span>
                    <span className="block text-xs text-muted-foreground">book value</span>
                  </span>
                </li>
              ))}
            </ul>
            <FieldDescription className="px-1 text-xs">
              Approved buyers buy it at a discount while reserves are below the target.
            </FieldDescription>
          </div>
        </>
      )}
    </Panel>
  )
}
