import type {
  InstrumentId,
  MarketId,
  Operation,
  PositionNumbers,
  TokenSymbol,
} from '@lending/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  CheckCircleIcon,
  InfoIcon,
  PauseCircleIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { type ReactNode, useDeferredValue, useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { TokenIcon } from '@/components/brand'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useFaucet, useNetworkBlocked, useRoles, useWalletBalances } from '@/hooks/app'
import {
  humanize,
  isUserRejection,
  useAccount,
  useConfig,
  useOperation,
  usePool,
  usePreview,
} from '@/hooks/data'
import {
  compareAmounts,
  formatAmount,
  formatPercent,
  formatUsd,
  isAmount,
  isNegative,
  isZero,
} from '@/lib/amount'
import { marketsOf } from '@/lib/tokens'
import { cn } from '@/lib/utils'
import { useWallet } from '@/wallet/context'
import { LoopAccountWait } from './AccountWait'
import { useAction } from './action'
import { SigningSummary } from './SigningNotice'
import { RiskBar } from './HealthBar'
import { riskTone } from './health'

/** Exact amount for the field: a decimal string without trailing zeros ("1013.6434964413"). */
const exact = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v)

const schema = z.object({
  amount: z
    .string()
    .trim()
    .refine((v) => isAmount(v), 'Enter a number with up to 10 decimals')
    .refine((v) => !isZero(v), 'Enter an amount above zero'),
})

const isCollateralOp = (op: Operation) =>
  op === 'deposit-collateral' || op === 'withdraw-collateral'

/** What the dialog shows: title, caption and the verb for the result, e.g. "Supply USDCx". */
function meta(op: Operation, m: MarketId) {
  switch (op) {
    case 'supply':
      return {
        title: 'Supply USDCx',
        note: 'Earn the supply APR. If you have a debt, it is repaid first.',
        done: 'supplied',
      }
    case 'repay':
      return {
        title: 'Repay USDCx',
        note: 'Pays down your USDCx debt. Anything above the debt is supplied and earns interest.',
        done: 'repaid',
      }
    case 'withdraw':
      return {
        title: 'Withdraw USDCx',
        note: null,
        done: 'withdrew',
      }
    case 'borrow':
      return {
        title: 'Borrow USDCx',
        note: 'Against all your collateral. Your supply is used first; the debt accrues the borrow APR.',
        done: 'borrowed',
      }
    case 'deposit-collateral':
      return {
        title: `Supply ${m}`,
        note: `${m} is collateral: it adds to your borrow capacity and earns no interest.`,
        done: 'supplied',
      }
    case 'withdraw-collateral':
      return {
        title: `Withdraw ${m}`,
        note: 'Collateral comes back while your debt stays within the borrow capacity of the rest.',
        done: 'withdrew',
      }
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  )
}

/** "before → after": the after value only when the preview reached it and it differs. */
function Change({
  before,
  after,
  format,
  formatAfter = format,
  tone,
  toneAfter = tone,
}: {
  before: string | null
  after: string | null | undefined
  format: (v: string | null) => string
  /** the after side when null means something else there (e.g. the debt is repaid) */
  formatAfter?: (v: string | null) => string
  tone?: (v: string | null) => string
  toneAfter?: (v: string | null) => string
}) {
  // the same value can read differently after: a null risk is "no debt" before and "unknown" with
  // the new debt (review 08.10, item 2), so the words are compared too
  const changed = after !== undefined && (after !== before || formatAfter(after) !== format(before))
  return (
    <>
      <span className={tone?.(before)}>{format(before)}</span>
      {changed && (
        <>
          <span aria-hidden="true" className="text-muted-foreground">
            {' '}
            →{' '}
          </span>
          <span className="sr-only">, after this action </span>
          <span className={toneAfter?.(after ?? null)}>{formatAfter(after ?? null)}</span>
        </>
      )}
    </>
  )
}

/** A missing balance or position in words, with the next step as buttons: never a silent block. */
function Remedy({
  tone = 'info',
  children,
  actions,
}: {
  tone?: 'info' | 'warning'
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <Alert variant={tone} role={undefined}>
      {tone === 'warning' ? <WarningIcon weight="bold" /> : <InfoIcon weight="fill" />}
      <AlertDescription className="flex flex-col gap-2.5">
        <p>{children}</p>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </AlertDescription>
    </Alert>
  )
}

/** Test faucet button inside a remedy (DevNet): the same faucet as on the dashboard. */
function FaucetButton({ symbol }: { symbol: TokenSymbol }) {
  const faucet = useFaucet()
  const config = useConfig()
  if (!config.data?.testFaucet) return null
  const pending = faucet.isPendingFor(symbol)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending}
      onClick={() => faucet.mutate(symbol)}
    >
      {pending && <Spinner data-icon="inline-start" />}
      Get test {symbol}
    </Button>
  )
}

/** Before the form: no wallet, a service role or no account yet, with the way forward. */
function NotReady({ title }: { title: string }) {
  const wallet = useWallet()
  const roles = useRoles()
  const account = useAccount()
  const open = useOperation('open-account')
  const { setOpen } = useAction()
  const signedIn = !!wallet.party && wallet.signedIn
  return (
    <>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription id="action-note" className="mt-2">
        {!signedIn
          ? 'Connect a wallet to continue.'
          : roles.isService
            ? 'Service roles (guardian, treasury, liquidator, backstop) do not supply or borrow. Sign in with a user wallet.'
            : account.isPending
              ? 'Loading your account…'
              : account.isError
                ? `Your account could not be loaded: ${account.error.message}. It reloads automatically; try again in a moment.`
                : wallet.kind === 'loop'
                  ? 'Your lending account holds your USDCx balance and all your collateral.'
                  : 'You need a lending account first. It holds your USDCx balance and all your collateral; the protocol opens it a few seconds after you sign the request.'}
      </DialogDescription>
      <div className="mt-5 flex flex-col gap-2">
        {!signedIn ? (
          <Button
            size="lg"
            onClick={() => {
              setOpen(false)
              void wallet.connectLoop()
            }}
          >
            Connect wallet
          </Button>
        ) : roles.isService || account.isPending || account.isError ? null : wallet.kind ===
          'loop' ? (
          <LoopAccountWait />
        ) : (
          <>
            <Button
              size="lg"
              disabled={open.isPending || open.isSuccess}
              aria-busy={open.isPending || open.isSuccess}
              onClick={() => open.mutate({})}
            >
              {(open.isPending || open.isSuccess) && <Spinner data-icon="inline-start" />}
              {open.isPending
                ? 'Waiting for signature…'
                : open.isSuccess
                  ? 'Opening…'
                  : 'Open account'}
            </Button>
            <p role="status" className="min-h-4 text-center text-xs text-muted-foreground">
              {open.isPending
                ? 'Confirm the request in your wallet.'
                : open.isSuccess
                  ? 'Request signed. This dialog continues as soon as the account is open.'
                  : ''}
            </p>
          </>
        )}
      </div>
    </>
  )
}

export function ActionDialog() {
  const { op, marketId, open, setOpen } = useAction()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent id="action-panel" aria-describedby="action-note">
        {open && <ActionForm key={`${op}-${marketId}`} op={op} marketId={marketId} />}
      </DialogContent>
    </Dialog>
  )
}

function ActionForm({ op, marketId }: { op: Operation; marketId: MarketId }) {
  const wallet = useWallet()
  const account = useAccount()
  const pool = usePool()
  const config = useConfig()
  const balances = useWalletBalances()
  const { setOpen, openAction } = useAction()
  const roles = useRoles()
  const { blocked: networkBlocked, reason: networkReason } = useNetworkBlocked()
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { amount: '' },
    mode: 'onChange',
  })
  const amount = (useWatch({ control: form.control, name: 'amount' }) ?? '').trim()
  const deferred = useDeferredValue(amount)
  const [done, setDone] = useState<{ amount: string; all: boolean } | null>(null)
  // Max for "withdraw all / repay all" writes the exact number into the field, and the command gets
  // `full`: the contract takes the exact amount at execution. Editing the number gives a normal amount
  const [allValue, setAllValue] = useState<string | null>(null)
  const all = allValue !== null && amount === allValue
  const deferredAll = allValue !== null && deferred === allValue
  const m = meta(op, marketId)
  const collateralOp = isCollateralOp(op)
  const unit = collateralOp ? marketId : 'USDCx'
  const validAmount = isAmount(deferred) && !isZero(deferred)
  const instruments = config.data?.instruments
  const instrument: InstrumentId | undefined =
    op === 'supply' || op === 'repay'
      ? instruments?.usdcx
      : op === 'deposit-collateral'
        ? instruments?.[marketId.toLowerCase() as 'cc' | 'cbtc']
        : undefined
  const preview = usePreview(
    op,
    deferred,
    deferredAll,
    collateralOp ? marketId : undefined,
    instrument,
    validAmount && !!account.data && done === null,
  )
  const mutation = useOperation(op)

  // Focus the amount field right after opening: Radix puts it on the first focusable
  useEffect(() => {
    requestAnimationFrame(() => document.getElementById('amount')?.focus())
  }, [])

  const a = account.data
  const s = a?.summary
  const collateral = a?.collateral.find((c) => c.marketId === marketId)
  const held = collateral?.amount ?? '0'
  const walletBalance = balances.data
    ? op === 'supply' || op === 'repay'
      ? balances.data.USDCx
      : op === 'deposit-collateral'
        ? balances.data[marketId]
        : null
    : null

  // Balance under the field and the Max button
  const balance: {
    label: string
    value: string | null
    fill: string | null
    /** fill is the exact "all": the command will carry `full` */
    all?: boolean
    aria: string
    digits?: number
  } =
    op === 'withdraw'
      ? {
          label: 'Supplied',
          value: s?.supplied ?? null,
          fill: s && !isZero(s.supplied) ? exact(s.supplied) : null,
          all: true,
          aria: `Max: ${formatAmount(s?.supplied, 4)}`,
        }
      : op === 'repay'
        ? {
            label: 'Debt',
            value: s?.borrowed ?? null,
            fill: s && !isZero(s.borrowed) ? exact(s.borrowed) : null,
            all: true,
            aria: `Repay all: ${formatAmount(s?.borrowed, 4)}`,
          }
        : op === 'withdraw-collateral'
          ? {
              label: 'Collateral',
              value: held,
              fill: !isZero(held) ? exact(held) : null,
              aria: `Max: ${formatAmount(held, 4)}`,
            }
          : op === 'borrow'
            ? {
                // Review 08.10, item 3: the field is what you receive, the deposit first, so Max
                // is the deposit plus the new debt available (maxBorrow from the backend)
                label: 'Up to',
                value: s?.maxBorrow ?? null,
                digits: 2,
                fill:
                  s && !isZero(s.maxBorrow) ? formatAmount(s.maxBorrow, 2).replace(/,/g, '') : null,
                aria: `Fill the most you can receive: ${formatAmount(s?.maxBorrow, 2)} USDCx`,
              }
            : {
                label: 'Wallet balance',
                value: walletBalance,
                fill: walletBalance && !isZero(walletBalance) ? walletBalance : null,
                aria: `Max: ${formatAmount(walletBalance, 4)}`,
              }

  if (!wallet.party || !wallet.signedIn || roles.isService || !a || !s)
    return <NotReady title={m.title} />

  if (done !== null) {
    const what = done.all
      ? op === 'repay'
        ? 'your whole debt'
        : 'your whole supply'
      : `${formatAmount(done.amount, 4)} ${unit}`
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <DialogTitle className="sr-only">{m.title}</DialogTitle>
        <span className="flex size-14 items-center justify-center rounded-full bg-success/12 text-success">
          <CheckCircleIcon size={34} weight="fill" />
        </span>
        <p className="mt-4 text-xl font-semibold">All done!</p>
        <DialogDescription id="action-note" className="mt-1">
          You {m.done} {what}.
        </DialogDescription>
        <Button size="lg" className="mt-6 w-full" onClick={() => setOpen(false)}>
          Ok, close
        </Button>
      </div>
    )
  }

  const p = pool.data
  const blockers = preview.data?.blockers ?? []
  const warnings = preview.data?.warnings ?? []
  // K6: while net reserves are negative, loans and USDCx withdrawals wait for recapitalization
  const recapitalizing = (op === 'withdraw' || op === 'borrow') && isNegative(p?.netReserves)
  const pausedFlag =
    (op === 'borrow' && !!p?.pauses.borrowPaused) ||
    (op === 'withdraw' && !!p?.pauses.supplyWithdrawPaused) ||
    (op === 'withdraw-collateral' && !!p?.pauses.collateralWithdrawPaused)
  const paused = pausedFlag || recapitalizing
  const previewFailed = validAmount && preview.isError
  // Send exactly the amount the preview was shown for (F-12)
  const previewCurrent = amount === deferred && !preview.isPlaceholderData
  const canSubmit =
    validAmount &&
    previewCurrent &&
    blockers.length === 0 &&
    !preview.isFetching &&
    !previewFailed &&
    !mutation.isPending &&
    !paused &&
    !networkBlocked
  const error = amount !== '' ? form.formState.errors.amount?.message : undefined
  const checking = validAmount && preview.isFetching
  const submitHint = mutation.isPending
    ? wallet.kind === 'loop'
      ? `Waiting for you to sign "${wallet.signing?.title ?? m.title}" in Loop.`
      : 'Confirm the transaction in your wallet.'
    : networkBlocked
      ? `Signing is blocked: ${networkReason ?? 'wrong network'}. Switch your wallet to the protocol network.`
      : paused
        ? 'This action is paused right now.'
        : amount === ''
          ? 'Enter an amount to continue.'
          : checking || (validAmount && !previewCurrent)
            ? 'Checking the amount with the protocol…'
            : previewFailed
              ? 'The protocol check failed. Try again in a moment.'
              : // a blocker is already spelled out in the alert right above the button
                ''
  const blocked = validAmount && blockers.length > 0

  // Before: from the preview, otherwise the account summary; after: only from the preview
  const before: PositionNumbers = preview.data?.before ?? {
    balance: s.balance,
    borrowCapacityUsd: s.borrowCapacityUsd,
    availableToBorrow: s.availableToBorrow,
    liquidationPointUsd: s.liquidationPointUsd,
    liquidationRisk: s.liquidationRisk,
  }
  const after = validAmount && preview.data?.after ? preview.data.after : null
  const warning = p?.limits.liquidationRiskWarning ?? '0.71'
  // A null risk is "no debt" without a debt and "unknown" (no usable price) with one
  const debtBefore = isNegative(before.balance)
  const debtAfter = after ? isNegative(after.balance) : debtBefore
  const riskText = (debt: boolean) => (v: string | null) =>
    v === null ? (debt ? 'unknown: no usable price' : 'no debt') : formatPercent(v, 1)
  const showRisk =
    debtBefore || before.liquidationRisk !== null || (after?.liquidationRisk ?? null) !== null
  const repaysDebt =
    validAmount && preview.data?.repaysDebt && !isZero(preview.data.repaysDebt)
      ? preview.data.repaysDebt
      : null
  const noCollateral = a.collateral.every((c) => isZero(c.amount))
  // The result of the last attempt for this amount: cancelled is not an error
  const failure =
    mutation.isError && mutation.variables?.amount === amount
      ? isUserRejection(mutation.error)
        ? { cancelled: true, text: 'Signature cancelled. Nothing was sent; you can sign again.' }
        : { cancelled: false, text: `Not completed: ${humanize(mutation.error.message)}` }
      : null
  // An empty liquidation point with collateral held means a price is missing, not "nothing"
  const point = (held: boolean) => (v: string | null) =>
    v === null && held ? 'no usable price' : formatUsd(v)
  const holdsAfter = !noCollateral || op === 'deposit-collateral'

  const onSubmit = form.handleSubmit(({ amount: v }) => {
    if (v !== deferred || !canSubmit) return
    const sentAll = allValue !== null && v === allValue
    mutation.mutate(
      {
        amount: v,
        all: sentAll,
        ...(collateralOp ? { marketId } : {}),
        ...(instrument ? { instrument } : {}),
        // Snapshot for checking "all" in the command (F-11)
        balance: s.supplied,
        debt: s.borrowed,
        ...(collateralOp ? { collateral: held } : {}),
      },
      { onSuccess: () => setDone({ amount: v, all: sentAll }) },
    )
  })
  // What is missing, said up front with the next step (never a silent block). The backend preview
  // stays the authority: these are the same facts it reports as blockers, shown before typing.
  const switchTo = (next: Operation, id?: MarketId) => (
    <Button
      key={`${next}-${id ?? ''}`}
      type="button"
      size="sm"
      variant="outline"
      onClick={() => openAction(next, id)}
    >
      {meta(next, id ?? marketId).title}
    </Button>
  )
  const fillMax =
    balance.fill && !all ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setAllValue(balance.all ? balance.fill : null)
          form.setValue('amount', balance.fill!, { shouldValidate: true })
        }}
      >
        Use {formatAmount(balance.fill, balance.digits ?? 4)} {unit}
      </Button>
    ) : null
  const fromWallet = op === 'supply' || op === 'repay' || op === 'deposit-collateral'
  const walletSymbol = unit as TokenSymbol
  const remedy: ReactNode =
    fromWallet && walletBalance !== null && isZero(walletBalance) ? (
      <Remedy tone="warning" actions={<FaucetButton symbol={walletSymbol} />}>
        Your wallet holds no {unit}. {op === 'deposit-collateral' ? 'Add' : 'Get'} {unit} to your
        wallet first
        {config.data?.testFaucet
          ? ": on this test network the faucet sends some. These are this app's own test tokens, not the assets of the same name in Loop."
          : '.'}
      </Remedy>
    ) : fromWallet &&
      walletBalance !== null &&
      validAmount &&
      compareAmounts(deferred, walletBalance) > 0 ? (
      <Remedy
        tone="warning"
        actions={
          <>
            {fillMax}
            <FaucetButton symbol={walletSymbol} />
          </>
        }
      >
        Your wallet holds {formatAmount(walletBalance, 4)} {unit}, less than{' '}
        {formatAmount(deferred, 4)}.
      </Remedy>
    ) : op === 'withdraw' &&
      !isZero(s.supplied) &&
      validAmount &&
      compareAmounts(deferred, s.supplied) > 0 ? (
      // review 03.10, item 7: a withdrawal never borrows; the way to more USDCx is one click away
      <Remedy actions={[fillMax, switchTo('borrow')].filter(Boolean)}>
        Withdraw takes only your supply, {formatAmount(s.supplied, 4)} USDCx, and never borrows. To
        take more USDCx against your collateral, borrow it.
      </Remedy>
    ) : op === 'withdraw' && isZero(s.supplied) ? (
      <Remedy actions={[switchTo('supply'), switchTo('borrow')]}>
        {isZero(s.borrowed)
          ? 'You have no USDCx supplied, so there is nothing to withdraw. Supply USDCx to earn, or borrow it against your collateral.'
          : 'You have a USDCx debt, not a deposit. Withdraw only takes your supply and never borrows: use Borrow to take more USDCx.'}
      </Remedy>
    ) : op === 'repay' && isZero(s.borrowed) ? (
      <Remedy actions={switchTo('supply')}>
        You have no USDCx debt to repay. Supplying USDCx earns the supply APR instead.
      </Remedy>
    ) : op === 'withdraw-collateral' && isZero(held) ? (
      <Remedy actions={switchTo('deposit-collateral', marketId)}>
        You have no {marketId} collateral to withdraw.
      </Remedy>
    ) : op === 'borrow' && noCollateral ? (
      <Remedy actions={marketsOf(config.data).map((id) => switchTo('deposit-collateral', id))}>
        No collateral yet. Supply CC or CBTC first: all your collateral backs one USDCx debt.
      </Remedy>
    ) : op === 'borrow' && isZero(s.availableToBorrow) && isZero(s.supplied) ? (
      <Remedy
        tone="warning"
        actions={marketsOf(config.data).map((id) => switchTo('deposit-collateral', id))}
      >
        Nothing is available to borrow right now: your debt is at your borrow capacity, a price is
        not valid, or the pool has no free USDCx. Adding collateral raises the capacity.
      </Remedy>
    ) : null

  // Exact "all" amount from the preview; until the preview answers, the account snapshot
  const previewAll = all && preview.data?.amount ? preview.data.amount : null
  const signed = (v: string | null) => (v === null ? '—' : `${formatAmount(v)} USDCx`)

  return (
    <>
      <DialogTitle>{m.title}</DialogTitle>
      {/* without a note the title is the description: the dialog still has one for screen readers */}
      <DialogDescription id="action-note" className={m.note ? 'mt-1' : 'sr-only'}>
        {m.note ?? m.title}
      </DialogDescription>

      <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-5" noValidate>
        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
          {remedy}
        </div>
        {paused && (
          <Alert variant="warning">
            <PauseCircleIcon weight="fill" />
            <AlertDescription>
              {recapitalizing
                ? 'Withdrawals and new loans wait for recapitalization: protocol reserves are negative after bad debt.'
                : op === 'borrow'
                  ? 'New loans are paused by the guardian.'
                  : op === 'withdraw'
                    ? 'USDCx withdrawals are paused by the guardian.'
                    : 'Collateral withdrawals are paused by the guardian.'}{' '}
              Supply, repayments and collateral deposits stay open.
            </AlertDescription>
          </Alert>
        )}

        <Field data-invalid={!!error || undefined} className="gap-2">
          <FieldLabel htmlFor="amount">Amount</FieldLabel>
          {/* Field with the token and Max inside the frame; the frame takes the field's focus and error */}
          <div
            className={cn(
              'rounded-lg border bg-card px-3 pt-2.5 pb-2 transition-[border-color,box-shadow] focus-within:ring-[3px]',
              error
                ? 'border-destructive focus-within:ring-destructive/20'
                : 'border-input focus-within:border-ring focus-within:ring-ring/20',
            )}
          >
            <div className="flex items-center gap-2">
              <Input
                id="amount"
                inputMode="decimal"
                enterKeyHint="done"
                autoComplete="off"
                spellCheck={false}
                placeholder="0.00"
                aria-invalid={!!error}
                aria-describedby={cn(
                  error && 'amount-error',
                  all && op === 'repay' && 'amount-max',
                  op === 'borrow' && !isZero(s.supplied) && 'amount-split',
                )}
                className="h-10 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-2xl font-semibold text-foreground shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0 aria-invalid:ring-0 md:text-2xl dark:bg-transparent"
                {...form.register('amount')}
              />
              <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground">
                <TokenIcon symbol={unit} className="size-6" />
                {unit}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
              <span>
                {balance.label}{' '}
                {balance.value !== null ? formatAmount(balance.value, balance.digits ?? 4) : '—'}
              </span>
              {balance.fill && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={balance.aria}
                  className="px-1 text-foreground uppercase"
                  onClick={() => {
                    setAllValue(balance.all ? balance.fill : null)
                    form.setValue('amount', balance.fill!, { shouldValidate: true })
                    document.getElementById('amount')?.focus()
                  }}
                >
                  Max
                </Button>
              )}
            </div>
          </div>
          {op === 'borrow' && !isZero(s.supplied) && (
            <FieldDescription id="amount-split" className="text-xs">
              {`You receive up to ${formatAmount(s.maxBorrow, 2)} USDCx. Your ${formatAmount(s.supplied, 2)} USDCx supply is paid out first; only the rest becomes debt.`}
            </FieldDescription>
          )}
          {all && op === 'repay' && (
            <FieldDescription id="amount-max" className="text-xs">
              {/* F-11: the command is marked "all": the wallet may be charged a little more */}
              {`Repay all: your debt is exactly ${previewAll ?? s.borrowed} USDCx now. Your wallet shows up to ${preview.data?.maxTransfer ?? 'a little more'} USDCx for interest until execution; the contract charges exactly the debt at that moment and returns the change.`}
            </FieldDescription>
          )}
          {error && (
            <FieldError id="amount-error" className="flex items-center gap-1.5">
              <WarningCircleIcon size={16} weight="bold" className="shrink-0" />
              {error}
            </FieldError>
          )}
        </Field>

        {repaysDebt && (
          <Alert variant="info">
            <InfoIcon weight="fill" />
            <AlertDescription>
              {op === 'supply'
                ? `Your debt is repaid first: ${formatAmount(repaysDebt, 4)} USDCx of this goes to the debt, the rest is supplied and earns the supply APR.`
                : `${formatAmount(repaysDebt, 4)} USDCx repays your debt; anything above it is supplied and earns interest.`}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Transaction overview</p>
          <dl className="divide-y rounded-lg border px-3">
            {(op === 'supply' || op === 'withdraw') && (
              <Row label="Net Supply APR">{formatPercent(p?.supplyApr)}</Row>
            )}
            {(op === 'borrow' || op === 'repay') && (
              <Row label="Net Borrow APR">{formatPercent(p?.borrowApr)}</Row>
            )}
            <Row label="USDCx balance">
              <Change before={before.balance} after={after?.balance} format={signed} />
            </Row>
            <Row label="Borrow capacity">
              <Change
                before={before.borrowCapacityUsd}
                after={after?.borrowCapacityUsd}
                format={(v) => formatUsd(v)}
              />
            </Row>
            <Row label="Available to borrow">
              <Change
                before={before.availableToBorrow}
                after={after?.availableToBorrow}
                format={signed}
              />
            </Row>
            <Row label="Liquidation point">
              <Change
                before={before.liquidationPointUsd}
                after={after?.liquidationPointUsd}
                format={point(!noCollateral)}
                formatAfter={point(holdsAfter)}
              />
            </Row>
            <div className="py-2.5 text-sm">
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted-foreground">Liquidation risk</dt>
                <dd className="text-right font-medium">
                  <Change
                    before={before.liquidationRisk}
                    after={after ? after.liquidationRisk : undefined}
                    format={riskText(debtBefore)}
                    formatAfter={riskText(debtAfter)}
                    tone={(v) => riskTone(v, warning, debtBefore)}
                    toneAfter={(v) => riskTone(v, warning, debtAfter)}
                  />
                  {(debtBefore || debtAfter) && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      Liquidation at 100%
                    </span>
                  )}
                </dd>
              </div>
              {showRisk && (
                <div className="mt-3">
                  <RiskBar
                    risk={before.liquidationRisk}
                    after={after ? after.liquidationRisk : null}
                    warning={warning}
                    hasDebt={debtBefore}
                  />
                </div>
              )}
            </div>
          </dl>
        </div>

        {/* The live region is the container itself: the Alert inside has its role removed so it is not announced twice */}
        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
          {validAmount &&
            warnings.map((w) => (
              <Alert key={w} role={undefined} variant="warning">
                <WarningIcon weight="bold" />
                <AlertDescription>{w}</AlertDescription>
              </Alert>
            ))}
          {blocked && (
            <Alert id="action-blockers" variant="destructive" role={undefined}>
              <WarningCircleIcon weight="bold" />
              <AlertDescription>
                <ul className="flex flex-col gap-1.5">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {failure && (
            // Review 08.10, item 8: the result stays here, not only in a toast that fades
            <Alert variant={failure.cancelled ? 'info' : 'destructive'} role={undefined}>
              {failure.cancelled ? <InfoIcon weight="fill" /> : <WarningCircleIcon weight="bold" />}
              <AlertDescription>{failure.text}</AlertDescription>
            </Alert>
          )}
          {previewFailed && (
            <Alert variant="destructive" role={undefined}>
              <WarningCircleIcon weight="bold" />
              <AlertDescription>
                Could not check this amount with the protocol: {preview.error.message}
              </AlertDescription>
            </Alert>
          )}
        </div>

        {wallet.signing && <SigningSummary summary={wallet.signing} />}

        <div>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={!canSubmit}
            aria-busy={mutation.isPending}
            aria-describedby={submitHint ? 'submit-hint' : blocked ? 'action-blockers' : undefined}
          >
            {mutation.isPending ? (
              <>
                <Spinner data-icon="inline-start" />
                Waiting for signature…
              </>
            ) : (
              m.title
            )}
          </Button>
          <p
            id="submit-hint"
            role="status"
            className="mt-2 min-h-4 text-center text-xs text-muted-foreground"
          >
            {submitHint}
          </p>
        </div>
      </form>
    </>
  )
}
