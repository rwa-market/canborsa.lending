import { type AccountView, type PriceView, priceIssue, type TokenSymbol } from '@lending/shared'
import {
  ArrowRightIcon,
  HandCoinsIcon,
  MinusIcon,
  PauseCircleIcon,
  PiggyBankIcon,
  PlusIcon,
  UserPlusIcon,
  WarningCircleIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { Panel, SectionTitle, TokenIcon } from '@/components/brand'
import { PageBody } from '@/components/layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import {
  useFaucet,
  useNetworkBlocked,
  useNetworkLabel,
  useRoles,
  useWalletBalances,
} from '@/hooks/app'
import { useAccount, useConfig, useOperation, usePool } from '@/hooks/data'
import { formatAmount, formatPercent, formatUsd, isNegative, isZero } from '@/lib/amount'
import { marketsOf, tokenDigits, tokenName } from '@/lib/tokens'
import { cn } from '@/lib/utils'
import { useWallet } from '@/wallet/context'
import { PAUSE_LABELS } from '@/wallet/verify'
import { AbsorbNotice } from '@/features/AbsorbNotice'
import { LoopAccountWait } from '@/features/AccountWait'
import { useAction, useStartAction } from '@/features/action'
import { riskTone } from '@/features/health'
import { RiskBar } from '@/features/HealthBar'

/** Who the account is by the sign of its balance (K1): a debt or a deposit, not both. */
function sideOf(a: AccountView | null) {
  const s = a?.summary
  const borrower = !!s && isNegative(s.balance)
  const supplier = !!s && !borrower && !isZero(s.balance)
  return { borrower, supplier }
}

// First screen: the two things this app does (review 08.10, item 9) ---------------------------

function Scenarios() {
  return (
    <section aria-label="How it works" className="grid gap-3 sm:grid-cols-2">
      <div className="flex items-start gap-3 rounded-xl border bg-surface px-4 py-3">
        <PiggyBankIcon size={22} weight="duotone" className="mt-0.5 shrink-0 text-brand" />
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">Earn.</span> Supply USDCx: it earns the
          supply APR until you withdraw it.
        </p>
      </div>
      <div className="flex items-start gap-3 rounded-xl border bg-surface px-4 py-3">
        <HandCoinsIcon size={22} weight="duotone" className="mt-0.5 shrink-0 text-brand" />
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">Borrow.</span> Supply CC or CBTC as
          collateral, then borrow USDCx against it.
        </p>
      </div>
    </section>
  )
}

/**
 * The pool's price of an asset, looked up by its InstrumentId (rule 2), not by the ticker: on a
 * real network CC is "Amulet". undefined while unknown, null without a feed.
 */
function usePriceOf() {
  const instruments = useConfig().data?.instruments
  const prices = usePool().data?.prices
  return (symbol: TokenSymbol): PriceView | null | undefined => {
    const id = instruments?.[symbol.toLowerCase() as 'usdcx' | 'cc' | 'cbtc']?.id
    // the pool lists every instrument (null: no feed); one missing from the answer is unknown
    return prices && id !== undefined && id in prices ? prices[id] : undefined
  }
}

/** Assets without a usable price with the reason each: "CC (stale price, oldest quote 6 min old)". */
function priceIssues(
  symbols: TokenSymbol[],
  priceOf: (s: TokenSymbol) => PriceView | null | undefined,
): string[] {
  return symbols.flatMap((sym) => {
    const pv = priceOf(sym)
    const issue = pv === undefined ? null : priceIssue(pv)
    return issue ? [`${sym} (${issue})`] : []
  })
}

// Ф1: balance and two buttons -------------------------------------------------------

/** Two paired actions. The group has no visible caption: its name is for screen readers. */
function ActionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-2 sm:w-72">
      {children}
    </div>
  )
}

function BalanceCard({ a }: { a: AccountView | null }) {
  const act = useStartAction()
  const s = a?.summary
  const { borrower, supplier } = sideOf(a)
  // The backend gives both magnitudes: the frontend does not negate the signed balance
  const label = borrower ? 'USDCx borrowed' : supplier ? 'USDCx supplied' : 'USDCx balance'
  const value = s ? formatAmount(borrower ? s.borrowed : s.supplied) : '—'
  return (
    <Card asChild className="gap-5 p-5 sm:p-6 lg:flex-row lg:items-center">
      <section aria-label="USDCx balance">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <TokenIcon symbol="USDCx" className="size-12 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p
              className={cn(
                'font-display text-[2rem] leading-tight font-semibold tracking-tight break-all sm:text-[2.5rem]',
                borrower && 'text-destructive',
              )}
            >
              {value}
            </p>
            <p className="text-sm text-muted-foreground">
              Net APR{' '}
              <span
                className={cn(
                  'font-semibold text-foreground',
                  isNegative(s?.netApr) && 'text-destructive',
                )}
              >
                {formatPercent(s?.netApr)}
              </span>
            </p>
          </div>
        </div>
        {/* All four USDCx actions, always: earning on the left, borrowing on the right. None is
            disabled for a missing balance or debt: the dialog says what is missing. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
          <ActionGroup label="Earn">
            <Button size="lg" className="px-3 text-sm" onClick={act('supply')}>
              Supply USDCx
            </Button>
            <Button size="lg" variant="outline" className="px-3 text-sm" onClick={act('withdraw')}>
              Withdraw USDCx
            </Button>
          </ActionGroup>
          <div aria-hidden="true" className="h-px bg-border sm:h-11 sm:w-px" />
          <ActionGroup label="Borrow">
            <Button size="lg" className="px-3 text-sm" onClick={act('borrow')}>
              Borrow USDCx
            </Button>
            <Button size="lg" variant="outline" className="px-3 text-sm" onClick={act('repay')}>
              Repay USDCx
            </Button>
          </ActionGroup>
        </div>
      </section>
    </Card>
  )
}

// Collateral Asset / Protocol Balance ---------------------------------------------------

/** Free wallet balances of the signed-in user and whether the test faucet is on (DevNet). */
function useWalletView() {
  const wallet = useWallet()
  const config = useConfig().data
  const balances = useWalletBalances()
  const signedIn = !!wallet.party && wallet.signedIn
  return {
    /** null: a guest, or the balances have not loaded yet */
    balances: signedIn ? (balances.data ?? null) : null,
    faucet: !!config?.testFaucet && signedIn,
  }
}

/** Test tokens for one asset, next to its wallet balance (DevNet only). */
function FaucetLink({ symbol }: { symbol: TokenSymbol }) {
  const faucet = useFaucet()
  const pending = faucet.isPendingFor(symbol)
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto p-0 text-xs font-medium"
      disabled={pending}
      aria-busy={pending}
      onClick={() => faucet.mutate(symbol)}
    >
      {pending && <Spinner data-icon="inline-start" />}
      Get test {symbol}
    </Button>
  )
}

/**
 * Compound's collateral list: the asset with its wallet balance under the name, the balance in
 * the protocol on the right, then + and −. On a phone the protocol balance moves to its own line.
 */
function CollateralCard({ a }: { a: AccountView | null }) {
  const markets = marketsOf(useConfig().data)
  const priceOf = usePriceOf()
  const w = useWalletView()
  const act = useStartAction()
  return (
    <Card asChild className="gap-0 overflow-hidden py-0">
      <section aria-label="Collateral">
        <CardHeader className="gap-1 px-4 py-4 sm:px-6">
          <CardTitle asChild>
            <h2 className="text-lg leading-tight">Collateral</h2>
          </CardTitle>
          {w.faucet && <TestTokensNote />}
        </CardHeader>
        <div
          aria-hidden="true"
          className="hidden items-center gap-4 border-y bg-surface px-6 py-2.5 text-xs leading-tight font-medium text-muted-foreground md:flex"
        >
          <span className="flex-1">Collateral Asset</span>
          <span>Protocol Balance</span>
          {/* the width of the two buttons: the label ends where the amounts end */}
          <span className="w-20" />
        </div>
        <ul
          role="list"
          data-table="Collateral assets"
          className="divide-y divide-border border-t md:border-t-0"
        >
          {markets.map((id) => {
            const c = a?.collateral.find((x) => x.marketId === id)
            const amount = c?.amount ?? (a ? '0' : null)
            const has = !!amount && !isZero(amount)
            const inWallet = w.balances ? (w.balances[id] ?? '0') : null
            // the pool's view of the price: shown for every asset, held or not (review 08.10, item 1)
            const pv = priceOf(id)
            const issue = pv === undefined ? null : priceIssue(pv)
            return (
              <li
                key={id}
                aria-label={`${id} collateral`}
                className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 transition-colors hover:bg-accent/50 sm:px-6"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <TokenIcon symbol={id} className="size-8" />
                  <div className="min-w-0">
                    <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold">
                      <span className="truncate">{id}</span>
                      {(issue || (c && has && !c.priceValid)) && (
                        <Badge variant="warning" className="font-normal">
                          No valid price
                        </Badge>
                      )}
                    </p>
                    {issue && (
                      <p className="text-xs text-warning-foreground">
                        Price: {issue}.{has && ' It adds nothing to your borrow capacity now.'}
                      </p>
                    )}
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {inWallet === null ? (
                        tokenName(id)
                      ) : (
                        <>
                          <span className="whitespace-nowrap">
                            {formatAmount(inWallet, tokenDigits(id))} in wallet
                          </span>
                          {w.faucet && <FaucetLink symbol={id} />}
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-sm max-md:order-last max-md:w-full md:block md:text-right">
                  <span className="text-muted-foreground md:sr-only">Protocol Balance</span>
                  <span className="text-right">
                    <span className={cn('font-semibold', !has && 'text-muted-foreground')}>
                      {amount === null ? '—' : formatAmount(amount, tokenDigits(id))}
                    </span>
                    {a && (
                      <span className="block text-xs text-muted-foreground">
                        {c ? formatUsd(c.valueUsd) : '$0.00'}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label={`Withdraw ${id}`}
                    onClick={act('withdraw-collateral', id)}
                  >
                    <MinusIcon weight="bold" />
                  </Button>
                  <Button
                    size="icon-sm"
                    aria-label={`Supply ${id}`}
                    onClick={act('deposit-collateral', id)}
                  >
                    <PlusIcon weight="bold" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </section>
    </Card>
  )
}

// Right column: USDCx in the wallet with the rates, then Position Summary --------------------

/** "Label left, value right" list inside a card. */
function Rows({ rows }: { rows: { label: ReactNode; value: ReactNode; key: string }[] }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {rows.map((r) => (
        <div key={r.key} className="flex items-baseline justify-between gap-3 py-2.5">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="text-right font-semibold whitespace-nowrap">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Review 08.10, item 7: the test tokens come from this app's own registries. The same ticker in
 * Loop is another asset with another balance.
 */
function TestTokensNote() {
  const network = useNetworkLabel().name
  return (
    <p className="text-xs text-muted-foreground">
      Test tokens of this app{network ? ` on ${network}` : ''}: its own USDCx, CC and CBTC, not the
      assets of the same name in Loop. Loop may not list them.
    </p>
  )
}

/** Compound's right card: the base asset in the wallet, then the two rates of the market. */
function WalletRatesCard() {
  const p = usePool().data
  const w = useWalletView()
  const faucet = useFaucet()
  const pending = faucet.isPendingFor('USDCx')
  return (
    <Panel aria-label="USDCx wallet balance and rates" className="gap-4">
      <SectionTitle title="USDCx Wallet Balance" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <TokenIcon symbol="USDCx" className="size-9 shrink-0" />
        <p className="font-display text-[1.75rem] leading-none font-semibold tabular-nums">
          {w.balances ? formatAmount(w.balances.USDCx ?? '0', tokenDigits('USDCx')) : '—'}
        </p>
        {w.faucet && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="ml-auto"
            disabled={pending}
            aria-busy={pending}
            onClick={() => faucet.mutate('USDCx')}
          >
            {pending && <Spinner data-icon="inline-start" />}
            Get test USDCx
          </Button>
        )}
      </div>
      {w.faucet && <TestTokensNote />}
      <Separator />
      <dl className="flex items-start justify-between gap-4">
        <div>
          <dt className="text-xs text-muted-foreground">Net Borrow APR</dt>
          <dd className="font-display text-xl font-semibold">{formatPercent(p?.borrowApr)}</dd>
        </div>
        <div className="text-right">
          <dt className="text-xs text-muted-foreground">Net Supply APR</dt>
          <dd className="font-display text-xl font-semibold">{formatPercent(p?.supplyApr)}</dd>
        </div>
      </dl>
    </Panel>
  )
}

function PositionSummary({ a }: { a: AccountView | null }) {
  const pool = usePool()
  const priceOf = usePriceOf()
  const s = a?.summary
  const held = a?.collateral.filter((c) => !isZero(c.amount)).map((c) => c.marketId) ?? []
  // the USDCx price and the price of every held asset, each with its reason (review 08.10, item 1)
  const issues = priceIssues(['USDCx', ...held], priceOf)
  const warning = pool.data?.limits.liquidationRiskWarning ?? '0.71'
  const hasDebt = !!s && !isZero(s.borrowed)
  return (
    <Panel aria-label="Position Summary" className="gap-3">
      <SectionTitle title="Position Summary" />
      <Rows
        rows={[
          // Compound's order: value, liquidation point, capacity, available; risk is ours (Ф2)
          {
            key: 'cv',
            label: 'Collateral Value',
            value: s ? formatUsd(s.collateralValueUsd) : '—',
          },
          {
            key: 'lp',
            label: 'Liquidation Point',
            // empty because a held asset has no usable price: say so, not a bare dash
            value:
              s && s.liquidationPointUsd === null && held.length > 0 ? (
                <span className="font-normal text-muted-foreground">Price unavailable</span>
              ) : s ? (
                formatUsd(s.liquidationPointUsd)
              ) : (
                '—'
              ),
          },
          {
            key: 'bc',
            label: 'Borrow Capacity',
            value: s ? formatUsd(s.borrowCapacityUsd) : '—',
          },
          {
            key: 'ab',
            label: 'Available to Borrow',
            value: s ? `${formatAmount(s.availableToBorrow)} USDCx` : '—',
          },
          {
            key: 'lr',
            label: 'Liquidation Risk',
            // a guest has no position: a dash, not a green 0%
            value: !s ? (
              '—'
            ) : (
              <span className={riskTone(s.liquidationRisk, warning, hasDebt)}>
                {s.liquidationRisk
                  ? formatPercent(s.liquidationRisk, 1)
                  : hasDebt
                    ? 'Price unavailable'
                    : '0%'}
              </span>
            ),
          },
        ]}
      />
      {hasDebt && <RiskBar risk={s.liquidationRisk} warning={warning} hasDebt />}
      {hasDebt && s.status === 'unknown' && (
        <p className="text-xs text-muted-foreground">
          {issues.length
            ? `No usable price for ${issues.join(' and ')}`
            : 'A collateral or USDCx price is not usable right now'}
          , so the risk cannot be valued. The protocol cannot absorb your account meanwhile, but it
          can as soon as prices return.
        </p>
      )}
      {hasDebt && s.absorbPenaltyUsd && (
        <p className="text-xs text-muted-foreground">
          If your position is liquidated, the protocol takes all your collateral and you lose about{' '}
          <span className="font-semibold text-foreground">{formatUsd(s.absorbPenaltyUsd)}</span>{' '}
          (the liquidation penalty).
        </p>
      )}
    </Panel>
  )
}

/** Risk banner: the account is above the warning level or can be absorbed. */
function RiskBanner({ a }: { a: AccountView }) {
  const pool = usePool()
  const markets = marketsOf(useConfig().data)
  const { openAction } = useAction()
  const s = a.summary
  if (s.status !== 'warning' && s.status !== 'liquidatable') return null
  const bad = s.status === 'liquidatable'
  const warning = pool.data?.limits.liquidationRiskWarning ?? '0.71'
  const held = a.collateral.find((c) => !isZero(c.amount))?.marketId ?? markets[0] ?? 'CC'
  return (
    <Alert role="alert" variant={bad ? 'destructive' : 'warning'} className="rounded-xl p-4">
      <WarningOctagonIcon weight="fill" />
      <AlertTitle className="font-semibold">
        {bad
          ? 'Your position can be liquidated'
          : `Liquidation risk is above ${formatPercent(warning, 0)}`}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>
          Your debt is {formatPercent(s.liquidationRisk, 1)} of your liquidation point. Repay USDCx
          or add collateral to lower the risk.
          {s.absorbPenaltyUsd &&
            ` If liquidated, you lose about ${formatUsd(s.absorbPenaltyUsd)} of collateral value.`}
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => openAction('repay')}>
            Repay
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openAction('deposit-collateral', held)}
          >
            Add collateral
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

/** Compound's single market screen: balance on top, collateral left, wallet and summary right. */
function MarketScreen({ a }: { a: AccountView | null }) {
  return (
    <>
      <BalanceCard a={a} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <CollateralCard a={a} />
        <div className="flex flex-col gap-6">
          <WalletRatesCard />
          <PositionSummary a={a} />
        </div>
      </div>
    </>
  )
}

/** How long to wait for the accounts bot after signing the request (F-18). */
const OPEN_TIMEOUT_MS = 60_000

function OpenAccount() {
  const open = useOperation('open-account')
  const { blocked } = useNetworkBlocked()
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!open.isSuccess) return
    const t = setTimeout(() => setLate(true), OPEN_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [open.isSuccess])
  const opening = open.isSuccess && !late
  return (
    <Card asChild className="min-h-[22rem] justify-center py-0">
      <section aria-label="Open account">
        <Empty className="px-6 py-12 md:px-6 md:py-12">
          <EmptyHeader className="max-w-md">
            <EmptyMedia variant="icon" className="size-12 rounded-full">
              <UserPlusIcon size={24} weight="duotone" />
            </EmptyMedia>
            <EmptyTitle className="font-semibold">
              <h2>Open your lending account</h2>
            </EmptyTitle>
            <EmptyDescription>
              One account holds your USDCx balance and all your collateral. The protocol opens it a
              few seconds after you sign the request.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="gap-2">
            <Button
              onClick={() => open.mutate({})}
              disabled={open.isPending || opening || blocked}
              aria-busy={open.isPending || opening}
              aria-describedby="open-account-status"
            >
              {(open.isPending || opening) && <Spinner data-icon="inline-start" />}
              {open.isPending ? 'Waiting for signature…' : opening ? 'Opening…' : 'Open account'}
            </Button>
            <p
              id="open-account-status"
              role="status"
              className="min-h-5 text-xs text-muted-foreground"
            >
              {open.isPending
                ? 'Confirm the request in your wallet.'
                : opening
                  ? 'Request signed. Your account appears here in a few seconds.'
                  : late
                    ? 'Your account is not open yet. The protocol may be busy: sign the request again or come back later.'
                    : ''}
            </p>
            {late && (
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => {
                  setLate(false)
                  open.reset()
                }}
              >
                Try again
              </Button>
            )}
          </EmptyContent>
        </Empty>
      </section>
    </Card>
  )
}

function ServiceRole() {
  const roles = useRoles()
  const name = roles.isGuardian
    ? 'Guardian'
    : roles.isTreasury
      ? 'Treasury'
      : roles.isBackstop
        ? 'Backstop'
        : 'Liquidator'
  const admin = roles.isGuardian || roles.isTreasury
  const page = admin ? 'Admin' : 'Buy collateral'
  return (
    <Card asChild className="sm:flex-row sm:items-center">
      <section aria-label="Service role">
        <CardHeader className="flex-1">
          <CardTitle asChild>
            <h2 className="text-lg">Signed in as {name}</h2>
          </CardTitle>
          <CardDescription>
            Service roles do not supply or borrow. Your tools are on the {page} page.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link to={admin ? '/admin' : '/liquidations'}>
              Open {page}
              <ArrowRightIcon weight="bold" data-icon="inline-end" />
            </Link>
          </Button>
        </CardFooter>
      </section>
    </Card>
  )
}

/** The USDCx price is not usable: new loans wait, whatever the position (review 08.10, item 1). */
function DebtPriceNotice() {
  const pv = usePriceOf()('USDCx')
  const issue = pv === undefined ? null : priceIssue(pv)
  if (!issue) return null
  return (
    <Alert variant="warning">
      <WarningCircleIcon weight="fill" />
      <AlertDescription>
        USDCx price: {issue}. New loans wait for the next valid price; supply and repayments stay
        open.
      </AlertDescription>
    </Alert>
  )
}

/** User-facing pauses in words: supply, repayments and collateral deposits are never paused. */
function PauseNotice() {
  const p = usePool().data
  if (!p) return null
  const flags = (['borrowPaused', 'supplyWithdrawPaused', 'collateralWithdrawPaused'] as const)
    .filter((k) => p.pauses[k])
    .map((k) => PAUSE_LABELS[k].toLowerCase())
  return (
    <>
      {isNegative(p.netReserves) && (
        <Alert variant="warning">
          <WarningCircleIcon weight="fill" />
          <AlertDescription>
            Withdrawals and new loans are closed: protocol reserves are negative after bad debt.
            They reopen once the treasury adds reserves; supply, repayments and collateral deposits
            stay open.
          </AlertDescription>
        </Alert>
      )}
      {flags.length > 0 && (
        <Alert variant="warning">
          <PauseCircleIcon weight="fill" />
          <AlertDescription>
            Paused by the guardian: {flags.join(', ')}. Supply, repayments and collateral deposits
            stay open.
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

export function DashboardPage() {
  const wallet = useWallet()
  const account = useAccount()
  const roles = useRoles()
  const { blocked, reason } = useNetworkBlocked()
  const a = account.data
  const signedIn = !!wallet.party && wallet.signedIn

  return (
    <>
      {/* No title band, as on Compound: the balance comes first; the market chip is in the header */}
      <h1 className="sr-only">Dashboard</h1>
      <PageBody className="flex flex-col gap-6">
        {blocked && (
          <Alert variant="destructive">
            <AlertDescription>
              Signing is blocked: {reason}. Switch your wallet to the protocol network and
              reconnect.
            </AlertDescription>
          </Alert>
        )}
        <PauseNotice />
        <DebtPriceNotice />
        {!roles.isService && <Scenarios />}
        {!signedIn ? (
          <MarketScreen a={null} />
        ) : roles.isService ? (
          <ServiceRole />
        ) : account.isPending ? (
          <Skeleton label="Loading your account…" className="h-80 w-full rounded-xl" />
        ) : account.isError ? (
          <Alert variant="destructive" className="rounded-xl p-4">
            <WarningCircleIcon weight="bold" />
            <AlertDescription>Account is unavailable: {account.error.message}</AlertDescription>
          </Alert>
        ) : !a ? (
          wallet.kind === 'loop' ? (
            <Card className="min-h-[14rem] justify-center p-6">
              <LoopAccountWait />
            </Card>
          ) : (
            <OpenAccount />
          )
        ) : (
          <>
            <AbsorbNotice />
            <RiskBanner a={a} />
            <MarketScreen a={a} />
          </>
        )}
      </PageBody>
    </>
  )
}
