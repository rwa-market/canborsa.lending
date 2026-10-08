import type { PoolView } from '@lending/shared'
import { PauseCircleIcon, WarningIcon } from '@phosphor-icons/react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Panel, TokenIcon } from '@/components/brand'
import { PageBody, PageTop } from '@/components/layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useNetworkLabel } from '@/hooks/app'
import { usePool } from '@/hooks/data'
import { formatAmount, formatPercent, formatUsd } from '@/lib/amount'
import { PAUSE_FLAGS } from '@/wallet/verify'
import { MARKET_SLUG } from '@/features/market/parts'

/** Small utilization ring for the markets table, as on app.compound.xyz/markets. */
function UtilizationRing({ value }: { value: string }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0))
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 18 18" className="size-[18px] shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--muted)" strokeWidth="2.5" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="var(--success)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${v * c} ${c}`}
      />
    </svg>
  )
}

const COLUMNS = [
  'Market',
  'Utilization',
  'Net Earn APR',
  'Net Borrow APR',
  'Total Earning',
  'Total Borrowing',
  'Total Collateral',
  'Collateral Assets',
] as const

/** One market row: the whole row opens the market page; the name is the link for keyboards. */
function MarketRow({ p, network }: { p: PoolView; network: string }) {
  const navigate = useNavigate()
  const open = () => void navigate({ to: '/markets/$market', params: { market: MARKET_SLUG } })
  const paused = PAUSE_FLAGS.some((k) => p.pauses[k])
  const cells: [string, React.ReactNode][] = [
    [
      'Utilization',
      <span key="u" className="inline-flex items-center gap-2">
        <UtilizationRing value={p.utilization} />
        {formatPercent(p.utilization)}
      </span>,
    ],
    ['Net Earn APR', formatPercent(p.supplyApr)],
    ['Net Borrow APR', formatPercent(p.borrowApr)],
    ['Total Earning', `${formatAmount(p.totalSupplied, 0)} USDCx`],
    ['Total Borrowing', `${formatAmount(p.totalBorrowed, 0)} USDCx`],
    ['Total Collateral', formatUsd(p.totalCollateralUsd)],
    [
      'Collateral Assets',
      <span key="c" className="inline-flex items-center gap-2">
        {p.markets.length}
        <span className="flex -space-x-1.5">
          {p.markets.map((m) => (
            <TokenIcon
              key={m.marketId}
              symbol={m.marketId}
              className="size-5 rounded-full ring-2 ring-card"
            />
          ))}
        </span>
      </span>,
    ],
  ]
  return (
    <li
      aria-label={`USDCx market on ${network}`}
      onClick={open}
      className="group grid cursor-pointer gap-3 rounded-lg border border-transparent px-4 py-4 transition-colors hover:border-primary/40 hover:bg-accent/50 md:grid-cols-[minmax(13rem,1.6fr)_repeat(7,minmax(0,1fr))] md:items-center md:gap-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <TokenIcon symbol="USDCx" className="size-9 shrink-0" />
        <div className="min-w-0">
          <Link
            to="/markets/$market"
            params={{ market: MARKET_SLUG }}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 font-semibold hover:underline focus-visible:underline"
          >
            USD Coin (Canton)
            {paused && (
              <Badge variant="warning" className="font-normal">
                Paused
              </Badge>
            )}
          </Link>
          <p className="text-xs text-muted-foreground">USDCx · Canton {network}</p>
        </div>
      </div>
      {cells.map(([label, value]) => (
        <div
          key={label}
          className="flex items-center justify-between gap-3 text-sm md:block md:text-[15px]"
        >
          <span className="text-muted-foreground md:sr-only">{label}</span>
          <span className="font-semibold tabular-nums">{value}</span>
        </div>
      ))}
    </li>
  )
}

/** All markets, as app.compound.xyz/markets: here one USDCx market per deployment. */
export function MarketsPage() {
  const pool = usePool()
  const network = useNetworkLabel().name ?? 'Network'
  const p = pool.data
  return (
    <>
      <PageTop
        title="Markets"
        description="Supply USDCx to earn, or borrow it against your collateral. Open a market to see its rates and collateral and to supply or borrow there."
        stats={[
          {
            label: 'Earning',
            value: p ? formatAmount(p.totalSupplied, 0) : '—',
            hint: 'USDCx supplied',
          },
          {
            label: 'Borrowing',
            value: p ? formatAmount(p.totalBorrowed, 0) : '—',
            hint: 'USDCx borrowed',
          },
          { label: 'Collateral', value: p ? formatUsd(p.totalCollateralUsd, 0) : '—' },
        ]}
      />
      <PageBody className="flex flex-col gap-6">
        {pool.isPending ? (
          <Skeleton label="Loading markets…" className="h-40 w-full rounded-xl" />
        ) : !p ? (
          <Alert variant="destructive">
            <WarningIcon weight="fill" />
            <AlertDescription>
              Markets are unavailable. They will reload automatically.
            </AlertDescription>
          </Alert>
        ) : (
          <Panel aria-label={`Canton ${network} markets`} className="gap-3 px-2 sm:px-3">
            {/* the network is in the header's market selector: no visible group title here */}
            <h2 className="sr-only">Canton {network}</h2>
            {PAUSE_FLAGS.some((k) => p.pauses[k]) && (
              <p className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground">
                <PauseCircleIcon weight="fill" /> Some actions are paused by the guardian
              </p>
            )}
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(13rem,1.6fr)_repeat(7,minmax(0,1fr))] gap-2 border-b px-4 pb-2 text-xs font-medium text-muted-foreground md:grid"
            >
              {COLUMNS.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <ul className="relative flex flex-col">
              <MarketRow p={p} network={network} />
            </ul>
          </Panel>
        )}
      </PageBody>
    </>
  )
}
