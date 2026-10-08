import type { AccountView, PoolView } from '@lending/shared'
import {
  ArrowLeftIcon,
  MinusIcon,
  PauseCircleIcon,
  PlusIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { Link, useParams } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Panel, SectionTitle, TokenIcon } from '@/components/brand'
import { AssetRow, AssetTable, Cell, type Column, PageBody, PageTop } from '@/components/layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useNetworkLabel, useRoles } from '@/hooks/app'
import { useAccount, usePool } from '@/hooks/data'
import { formatAmount, formatPercent, formatUsd, isNegative, isZero } from '@/lib/amount'
import { tokenDigits, totalDigits } from '@/lib/tokens'
import { cn } from '@/lib/utils'
import { useWallet } from '@/wallet/context'
import { PAUSE_FLAGS, PAUSE_LABELS } from '@/wallet/verify'
import { useStartAction } from '@/features/action'
import { riskTone } from '@/features/health'
import { RiskBar } from '@/features/HealthBar'
import { Asset, MARKET_SLUG, MarketFlags, RateChart } from '@/features/market/parts'
import { NotFound } from '@/features/NotFound'

/** Figure in a stats strip: small label over a large value. */
function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-display text-xl font-semibold break-words">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  )
}

/**
 * Target actions of the market: the four USDCx operations. Buttons are never disabled for a
 * missing balance or position: the dialog says what is missing and offers the next step.
 */
function YourPosition({ p }: { p: PoolView }) {
  const wallet = useWallet()
  const roles = useRoles()
  const account = useAccount()
  const start = useStartAction()
  const signedIn = !!wallet.party && wallet.signedIn
  const a = account.data
  const s = a?.summary
  const borrower = !!s && isNegative(s.balance)
  const warning = p.limits.liquidationRiskWarning
  const hasDebt = !!s && !isZero(s.borrowed)
  return (
    <Panel aria-label="Your position in this market">
      <SectionTitle
        title="Your position"
        hint={
          !signedIn
            ? 'Connect a wallet to supply USDCx or borrow it against CC and CBTC.'
            : roles.isService
              ? 'Service roles do not supply or borrow.'
              : account.isError
                ? `Your account could not be loaded: ${account.error.message}. It reloads automatically.`
                : !a && !account.isPending
                  ? 'Open your lending account to supply or borrow: the first action opens it.'
                  : 'One USDCx balance backed by all your collateral.'
        }
      />
      {signedIn && !roles.isService && (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label={borrower ? 'USDCx borrowed' : 'USDCx supplied'}
            value={
              <span className={cn(borrower && 'text-destructive')}>
                {s ? formatAmount(borrower ? s.borrowed : s.supplied) : '—'}
              </span>
            }
          />
          <Stat
            label="Net APR"
            value={
              <span className={cn(isNegative(s?.netApr) && 'text-destructive')}>
                {formatPercent(s?.netApr)}
              </span>
            }
          />
          <Stat
            label="Available to borrow"
            value={s ? formatAmount(s.availableToBorrow) : '—'}
            sub="USDCx"
          />
          <Stat
            label="Liquidation risk"
            value={
              !s ? (
                '—'
              ) : (
                <span className={riskTone(s.liquidationRisk, warning, hasDebt)}>
                  {s.liquidationRisk
                    ? formatPercent(s.liquidationRisk, 1)
                    : hasDebt
                      ? 'Price unavailable'
                      : '0%'}
                </span>
              )
            }
            sub={hasDebt ? 'Liquidation at 100%' : undefined}
          />
        </dl>
      )}
      {hasDebt && <RiskBar risk={s.liquidationRisk} warning={warning} hasDebt />}
      {!roles.isService && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Button size="lg" onClick={start('supply')}>
            Supply USDCx
          </Button>
          <Button size="lg" variant="outline" onClick={start('borrow')}>
            Borrow USDCx
          </Button>
          <Button size="lg" variant="outline" onClick={start('withdraw')}>
            Withdraw USDCx
          </Button>
          <Button size="lg" variant="outline" onClick={start('repay')}>
            Repay USDCx
          </Button>
        </div>
      )}
    </Panel>
  )
}

function MarketStats({ p }: { p: PoolView }) {
  const usdcx = p.prices.USDCx
  return (
    <Panel aria-label="Market stats">
      <SectionTitle title="Market Stats" />
      <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <Stat
          label={<RateLabel tone="bg-success">Net Earn APR</RateLabel>}
          value={formatPercent(p.supplyApr)}
          sub="interest only, no rewards"
        />
        <Stat
          label={<RateLabel tone="bg-primary">Net Borrow APR</RateLabel>}
          value={formatPercent(p.borrowApr)}
          sub="moves with utilization"
        />
        <Stat label="Total Earning" value={formatAmount(p.totalSupplied, 0)} sub="USDCx supplied" />
        <Stat
          label="Available Liquidity"
          value={formatAmount(p.availableLiquidity, 0)}
          sub={`USDCx, loans stop at ${formatPercent(p.limits.maxUtilization, 0)} utilization`}
        />
        <Stat
          label="Total Reserves"
          value={
            <span className={cn(isNegative(p.reserves) && 'text-destructive')}>
              {formatAmount(p.reserves, 0)}
            </span>
          }
          sub={`USDCx, target ${formatAmount(p.targetReserves, 0)}`}
        />
        <Stat
          label="Collateralization"
          value={p.collateralization ? formatPercent(p.collateralization, 2) : '—'}
          sub="collateral value / borrowing"
        />
        <Stat
          label="Oracle Price"
          value={usdcx ? formatUsd(usdcx.debtPrice, 4) : '—'}
          sub="USDCx"
        />
      </dl>
    </Panel>
  )
}

/** A rate's label with the dot of its line on the rate chart below. */
function RateLabel({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2 shrink-0 rounded-full', tone)} aria-hidden="true" />
      {children}
    </span>
  )
}

/** Collateral assets with the user's balance and supply / withdraw buttons on each row. */
function CollateralAssets({ p, a }: { p: PoolView; a: AccountView | null }) {
  const start = useStartAction()
  const roles = useRoles()
  const columns: Column[] = [
    { label: 'Asset', width: 'minmax(9rem,1.4fr)' },
    { label: 'Total Supply', width: 'minmax(max-content,1fr)' },
    { label: 'Reserves', width: 'minmax(max-content,0.8fr)' },
    { label: 'Oracle Price', width: 'minmax(max-content,0.8fr)' },
    { label: 'Collateral Factor', width: 'minmax(max-content,0.7fr)' },
    { label: 'Liquidation Factor', width: 'minmax(max-content,0.7fr)' },
    { label: 'Liquidation Penalty', width: 'minmax(max-content,0.7fr)' },
    { label: 'Your balance', width: 'minmax(max-content,0.8fr)' },
    { label: '', width: 'max-content' },
  ]
  return (
    // overflow-x-auto: between md and lg the nine columns are wider than the panel; the row keeps
    // its supply / withdraw buttons reachable by scrolling instead of cutting them off
    <Panel aria-label="Collateral assets" className="gap-0 overflow-x-auto px-0 pb-0 sm:px-0">
      <div className="px-5 pb-4 sm:px-6">
        <SectionTitle
          title="Collateral Assets"
          hint="Borrow up to the Collateral Factor of your collateral value. Debt above the Liquidation Factor gets the account liquidated, and the penalty is taken from the collateral."
        />
      </div>
      <AssetTable columns={columns} label="Collateral assets" numericWidth={78}>
        {p.markets.map((m) => {
          const mine = a?.collateral.find((c) => c.marketId === m.marketId)
          return (
            <AssetRow key={m.marketId} label={`${m.marketId} collateral asset`}>
              <div>
                <Asset symbol={m.marketId} />
                <MarketFlags m={m} />
              </div>
              <Cell label="Total Supply">
                <span className="font-semibold">{formatUsd(m.totalCollateralUsd, 0)}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatAmount(m.totalCollateral, totalDigits(m.marketId))} of{' '}
                  {formatAmount(m.supplyCap, totalDigits(m.marketId))} {m.marketId}
                </span>
              </Cell>
              <Cell label="Reserves">
                {/* absorbed collateral the protocol holds for sale; units, the frontend does not price it */}
                {formatAmount(m.protocolCollateral, tokenDigits(m.marketId))} {m.marketId}
              </Cell>
              <Cell label="Oracle Price">
                {m.price ? formatUsd(m.price, m.marketId === 'CC' ? 4 : 2) : '—'}
              </Cell>
              <Cell label="Collateral Factor">{formatPercent(m.borrowCollateralFactor, 0)}</Cell>
              <Cell label="Liquidation Factor">
                {formatPercent(m.liquidateCollateralFactor, 0)}
              </Cell>
              <Cell label="Liquidation Penalty">{formatPercent(m.liquidationPenalty, 0)}</Cell>
              <Cell label="Your balance">
                {mine ? formatAmount(mine.amount, tokenDigits(m.marketId)) : a ? '0' : '—'}
              </Cell>
              {roles.isService ? (
                <span />
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label={`Withdraw ${m.marketId}`}
                    onClick={start('withdraw-collateral', m.marketId)}
                  >
                    <MinusIcon weight="bold" />
                  </Button>
                  <Button
                    size="icon-sm"
                    aria-label={`Supply ${m.marketId}`}
                    onClick={start('deposit-collateral', m.marketId)}
                  >
                    <PlusIcon weight="bold" />
                  </Button>
                </div>
              )}
            </AssetRow>
          )
        })}
      </AssetTable>
    </Panel>
  )
}

/** Our launch limits and reserves: Compound has none of these (README, "What differs"). */
function AdditionalData({ p }: { p: PoolView }) {
  const rows: [string, string][] = [
    ['Total borrow cap', `${formatAmount(p.limits.totalBorrowCap, 0)} USDCx`],
    ['Max debt per user', `${formatAmount(p.limits.maxDebtPerUser, 0)} USDCx`],
    ['Minimum loan', `${formatAmount(p.limits.minLoan, 0)} USDCx`],
    ['Utilization ceiling', formatPercent(p.limits.maxUtilization, 0)],
    ['Net reserves', `${formatAmount(p.netReserves, 0)} USDCx`],
    ['Cash in the pool', `${formatAmount(p.cash, 0)} USDCx`],
  ]
  return (
    <Panel aria-label="Additional market data">
      <SectionTitle
        title="Additional Market Data"
        hint="Launch limits and reserves. Net reserves add the book value of absorbed collateral; while they are negative, new loans and withdrawals wait."
      />
      <dl className="grid gap-x-8 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 border-b py-2.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-semibold whitespace-nowrap">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

/** The USDCx market, as app.compound.xyz/markets/usdc-mainnet, with its actions on the page. */
export function MarketPage() {
  const { market } = useParams({ strict: false }) as { market?: string }
  const pool = usePool()
  const account = useAccount()
  const network = useNetworkLabel().name ?? 'Network'
  const p = pool.data
  if (market !== MARKET_SLUG) return <NotFound />
  const paused = p ? PAUSE_FLAGS.filter((k) => p.pauses[k]) : []
  return (
    <>
      <PageTop
        before={
          <Link
            to="/markets"
            className="mb-4 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon weight="bold" className="size-4 shrink-0" />
            Markets
          </Link>
        }
        icon={<TokenIcon symbol="USDCx" className="size-10" />}
        title={
          <>
            USDCx <span className="hidden text-muted-foreground sm:inline">· Canton {network}</span>
          </>
        }
        stats={[
          { label: 'Total Collateral', value: p ? formatUsd(p.totalCollateralUsd, 0) : '—' },
          {
            label: 'Total Borrowing',
            value: p ? formatAmount(p.totalBorrowed, 0) : '—',
            hint: 'USDCx',
          },
          { label: 'Utilization', value: p ? formatPercent(p.utilization, 1) : '—' },
        ]}
      />
      <PageBody className="flex flex-col gap-6">
        {pool.isPending ? (
          <Skeleton label="Loading the market…" className="h-80 w-full rounded-xl" />
        ) : !p ? (
          <Alert variant="destructive">
            <WarningIcon weight="fill" />
            <AlertDescription>
              The market is unavailable. It will reload automatically.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {isNegative(p.netReserves) && (
              <Alert variant="warning">
                <WarningIcon weight="fill" />
                <AlertDescription>
                  Withdrawals and new loans are closed: protocol reserves are negative after bad
                  debt. They reopen once the treasury adds reserves; supply, repayments and
                  collateral deposits stay open.
                </AlertDescription>
              </Alert>
            )}
            {paused.length > 0 && (
              <Alert variant="warning">
                <PauseCircleIcon weight="fill" />
                <AlertDescription>
                  Paused by the guardian:{' '}
                  {paused.map((k) => PAUSE_LABELS[k].toLowerCase()).join(', ')}. Supply, repayments
                  and collateral deposits stay open.
                </AlertDescription>
              </Alert>
            )}
            <YourPosition p={p} />
            <MarketStats p={p} />
            <Panel aria-label="Interest rate model">
              <SectionTitle
                title="Interest Rate Model"
                hint={`Reserve factor ${formatPercent(p.rateModel.reserveFactor, 0)}: the protocol keeps this share of the interest as reserves.`}
              />
              <RateChart p={p} />
            </Panel>
            <CollateralAssets p={p} a={account.data ?? null} />
            <AdditionalData p={p} />
          </>
        )}
      </PageBody>
    </>
  )
}
