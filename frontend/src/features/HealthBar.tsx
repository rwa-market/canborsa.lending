import { formatPercent } from '@/lib/amount'
import { cn } from '@/lib/utils'

/** Ratio for drawing the scale: display only, not money. Above 100 % the marker stays at the end. */
const at = (v: number) => Math.max(0, Math.min(100, v * 100))

/**
 * Liquidation Risk bar (Compound V3): debt / liquidation point in percent. Warning from
 * pool.limits.liquidationRiskWarning (0.71 by default), the position is absorbed at 100 %.
 * The value comes from the backend (AccountSummary.liquidationRisk, Preview.after): here it is
 * only placed on a linear scale.
 */
export function RiskBar({
  risk,
  after,
  warning = '0.71',
  hasDebt = false,
}: {
  /** null: no debt or no valid price */
  risk: string | null
  after?: string | null
  /** pool.limits.liquidationRiskWarning */
  warning?: string
  /** there is a debt: a null risk then means "unknown", not "no debt" */
  hasDebt?: boolean
}) {
  const parsed = Number(warning)
  const w = Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : 0.71
  const now = risk === null ? null : Number(risk)
  const next = after === undefined || after === null ? null : Number(after)
  const zone = (v: number) => (v >= 1 ? 'can be liquidated' : v >= w ? 'at risk' : 'safe')
  const tone = now === null ? 'none' : now >= 1 ? 'bad' : now >= w ? 'warn' : 'ok'
  const showNext = next !== null && (now === null || Math.abs(next - now) > 0.0005)
  // The scale is a picture: everything it shows by colour and position is duplicated as text
  const label =
    (now === null
      ? hasDebt
        ? 'Liquidation risk unknown: a price is not usable now'
        : 'Liquidation risk: no debt'
      : `Liquidation risk ${formatPercent(risk, 1)}, ${zone(now)}`) +
    (showNext ? `. After this action ${formatPercent(after, 1)}, ${zone(next)}` : '') +
    `. Warning from ${formatPercent(warning, 0)}, liquidation at 100%.`
  return (
    <div className="flex flex-col gap-1.5" role="img" aria-label={label}>
      <div
        data-slot="meter-track"
        className="relative h-2 rounded-full bg-gradient-to-r from-success/35 via-warning/35 via-70% to-destructive/45"
      >
        <span
          className="absolute inset-y-[-3px] w-px bg-warning"
          style={{ left: `${at(w)}%` }}
          aria-hidden="true"
        />
        {now !== null && (
          <span
            data-slot="meter-marker"
            className={cn(
              'absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-card shadow-md transition-[left] duration-700 ease-spring',
              tone === 'bad' && 'bg-destructive',
              tone === 'warn' && 'bg-warning',
              tone === 'ok' && 'bg-success',
            )}
            style={{ left: `${at(now)}%` }}
          />
        )}
        {showNext && (
          <span
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-foreground/70 bg-card"
            style={{ left: `${at(next)}%` }}
          />
        )}
      </div>
      <div className="relative h-4 text-xs text-muted-foreground" aria-hidden="true">
        <span className="absolute left-0">0%</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${at(w)}%` }}>
          {formatPercent(warning, 0)}
        </span>
        <span className="absolute right-0">100%</span>
      </div>
    </div>
  )
}
