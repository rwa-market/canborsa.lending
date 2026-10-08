import {
  Children,
  createContext,
  isValidElement,
  use,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

/** Page content width: header, title bar and body aligned to the same edges. */
export const CONTAINER = 'mx-auto w-full max-w-[1360px] px-4 sm:px-6'

export interface Stat {
  label: string
  value: ReactNode
  /** value colour: HF, warning */
  className?: string
  hint?: ReactNode
}

/**
 * Page title bar: a full-width band, title and description on the left,
 * key figures on the right. Below it, the grey page body with cards.
 */
export function PageTop({
  icon,
  title,
  badge,
  description,
  stats,
  before,
  children,
}: {
  icon?: ReactNode
  title: ReactNode
  badge?: ReactNode
  description?: ReactNode
  stats?: Stat[]
  /** above the title: a "Back" link */
  before?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="page-top border-b">
      {/* One height on all pages: content centred, "Back" adds no height */}
      <div className={cn(CONTAINER, 'flex flex-col justify-center py-8 lg:h-52 lg:py-0')}>
        {before}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 lg:max-w-[34rem]">
            <div className="flex items-center gap-3">
              {icon}
              <h1 className="truncate text-[1.875rem] leading-tight font-semibold sm:text-[2.5rem]">
                {title}
              </h1>
              {badge}
            </div>
            {description && (
              <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {stats && stats.length > 0 && (
            <dl className="grid grid-cols-2 overflow-hidden rounded-xl border bg-surface/70 backdrop-blur-sm sm:flex sm:flex-wrap">
              {stats.map((s) => (
                <div
                  key={s.label}
                  className="min-w-0 border-border px-5 py-4 max-sm:odd:border-r max-sm:[&:nth-child(n+3)]:border-t sm:min-w-36 sm:border-l sm:first:border-l-0"
                >
                  <dt className="text-[13px] text-muted-foreground">{s.label}</dt>
                  <dd
                    className={cn(
                      'mt-1 font-display text-2xl leading-tight font-semibold tracking-tight whitespace-nowrap sm:text-[1.75rem]',
                      s.className,
                    )}
                  >
                    {s.value}
                  </dd>
                  {s.hint && <dd className="mt-0.5 text-xs text-muted-foreground">{s.hint}</dd>}
                </div>
              ))}
            </dl>
          )}
        </div>
        {children}
      </div>
    </div>
  )
}

/** Page body under the title bar. */
export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(CONTAINER, 'py-6 sm:py-8', className)}>{children}</div>
}

export interface Column {
  label: ReactNode
  /**
   * column width on desktop: `max-content` fits the content (button column), an explicit
   * length (`12rem`) is used as is; `fr`/`minmax(…)`: width is distributed by table auto-layout.
   */
  width: string
  align?: 'left' | 'right'
}

const AssetTableContext = createContext<{ columns: Column[] }>({ columns: [] })

/**
 * Column width in the table layout. `max-content`: the column shrinks to its content
 * (1px + w-max on the content). `fr` shares are not converted to percent: together with a
 * content-sized column they would overflow a narrow card; free space is distributed by table
 * auto-layout. An explicit length (`12rem`) is used as is.
 */
function columnWidth(width: string, share: number | null): CSSProperties | undefined {
  if (width === 'max-content') return { width: '1px' }
  if (/^[\d.]+(rem|px|em)$/.test(width)) return { width }
  // Number columns have equal width: otherwise the table distributes space by content length,
  // and the gaps between cells come out uneven
  if (share !== null) return { width: `${share}%` }
  return undefined
}

/**
 * Share of each number column (all except the first, the asset, and content-sized columns):
 * `total` percent of the table width is split equally.
 */
function numericShare(columns: Column[], total: number): number | null {
  const n = columns.filter(
    (c, i) => i > 0 && c.width !== 'max-content' && !/^[\d.]+(rem|px|em)$/.test(c.width),
  ).length
  return n > 0 ? Math.floor((total / n) * 100) / 100 : null
}

/**
 * Asset table on shadcn Table: a header row on desktop, cards on a phone
 * with a label on each value. One DOM for both sizes: cell labels are visible only
 * on a narrow screen; on a wide one they remain for screen readers.
 *
 * Roles are a list (list/listitem), not a table: a row is read out whole by its
 * aria-label, and e2e finds rows as listitem. Each row is its own `<tbody>`, so a
 * full-width bar fits under it (`RowDetail`).
 */
export function AssetTable({
  columns,
  children,
  empty,
  label,
  numericWidth = 44,
}: {
  columns: Column[]
  /** Percent of the width shared by number columns; more for a wide table */
  numericWidth?: number
  children: ReactNode
  /** shown instead of the table when there are no rows */
  empty?: ReactNode
  label: string
}) {
  if (empty) return <>{empty}</>
  const share = numericShare(columns, numericWidth)
  return (
    <AssetTableContext value={{ columns }}>
      <Table role="list" data-table={label} className="max-md:block">
        <TableHeader aria-hidden="true" className="max-md:hidden">
          <TableRow className="border-y bg-surface hover:bg-surface">
            {columns.map((c, i) => (
              <TableHead
                key={i}
                style={i === 0 ? { width: '12.5rem' } : columnWidth(c.width, share)}
                className={cn(
                  'px-2 text-xs leading-tight font-medium whitespace-nowrap text-muted-foreground first:pl-6 last:pr-6',
                  c.align === 'right' && 'text-right',
                )}
              >
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        {children}
      </Table>
    </AssetTableContext>
  )
}

/** Full-width bar under a row: an ongoing liquidation, a position warning. */
export function RowDetail({ children }: { children: ReactNode }) {
  return <>{children}</>
}

const cellClass =
  'whitespace-normal max-md:block max-md:p-0 md:px-2 md:py-4 md:first:pl-6 md:last:pr-6'

/**
 * Asset table row: `<tbody role="listitem">`, each child element is a cell
 * (TableCell). `RowDetail` goes into a separate full-width row.
 */
export function AssetRow({
  children,
  className,
  label,
}: {
  children: ReactNode
  className?: string
  label?: string
}) {
  const { columns } = use(AssetTableContext)
  const items = Children.toArray(children)
  const isDetail = (c: ReactNode) => isValidElement(c) && c.type === RowDetail
  const cells = items.filter((c) => !isDetail(c))
  const details = items.filter(isDetail)
  return (
    <TableBody
      role="listitem"
      aria-label={label}
      className="border-b transition-colors last:border-b-0 hover:bg-accent/50 max-md:block"
    >
      <TableRow
        role="none"
        className={cn(
          'border-0 hover:bg-transparent max-md:flex max-md:flex-col max-md:gap-3 max-md:px-4 max-md:py-4 sm:max-md:px-6',
          details.length > 0 && 'max-md:pb-0',
          className,
        )}
      >
        {cells.map((c, i) => (
          <TableCell
            key={i}
            role="none"
            className={cn(
              cellClass,
              // content-sized column (buttons): the content does not shrink to 1px width
              columns[i]?.width === 'max-content' && 'md:*:ml-auto md:*:w-max',
              // the asset column has the same width in all tables, a long label is cut with
              // an ellipsis (truncate inside); numbers split the rest equally
              i === 0 && 'md:w-[12.5rem] md:min-w-[9rem] md:max-w-[12.5rem]',
            )}
          >
            {c}
          </TableCell>
        ))}
      </TableRow>
      {details.map((d, i) => (
        <TableRow
          key={i}
          role="none"
          className="border-0 hover:bg-transparent max-md:block max-md:px-4 max-md:py-4 sm:max-md:px-6"
        >
          <TableCell role="none" colSpan={columns.length} className={cn(cellClass, 'md:pt-0')}>
            {d}
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  )
}

/** Cell: the label is visible on a phone; on desktop it remains for screen readers. */
export function Cell({
  label,
  children,
  className,
  align,
}: {
  label: string
  children: ReactNode
  className?: string
  align?: 'left' | 'right'
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 text-sm md:block',
        align === 'right' && 'md:text-right [&>span:last-child]:md:text-right',
        className,
      )}
    >
      <span className="text-muted-foreground md:sr-only">{label}</span>
      <span className="text-right md:text-left">{children}</span>
    </div>
  )
}

/** Fill ring for a reserve's supply and borrow usage. The share is display only. */
export function Ring({
  value,
  tone = 'ok',
  label,
}: {
  value: number
  tone?: 'ok' | 'warn' | 'bad' | 'brand'
  label: string
}) {
  const v = Math.max(0, Math.min(100, value))
  const r = 26
  const c = 2 * Math.PI * r
  const stroke = {
    ok: 'var(--success)',
    warn: 'var(--warning)',
    bad: 'var(--destructive)',
    brand: 'var(--primary)',
  }[tone]
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      className="relative size-[4.5rem] shrink-0"
    >
      <svg viewBox="0 0 64 64" className="size-full -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--muted)" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          data-slot="meter-fill"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold">
        {v < 0.01 && v > 0 ? '<0.01' : v.toFixed(v >= 10 ? 0 : 2)}%
      </span>
    </div>
  )
}

/** Framed parameter, e.g. "Collateral Factor 30.00 %" in the collateral table. */
export function InfoBox({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="min-w-0 gap-0.5 rounded-lg bg-surface px-3 py-2.5 shadow-none">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-[15px] font-semibold">{value}</dd>
    </Card>
  )
}
