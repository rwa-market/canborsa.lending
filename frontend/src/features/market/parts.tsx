import type { MarketView, PoolView } from '@lending/shared'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { TokenIcon } from '@/components/brand'
import { Badge } from '@/components/ui/badge'
import { formatAmount, formatPercent, isZero } from '@/lib/amount'
import { tokenDigits, tokenName } from '@/lib/tokens'

/**
 * The one USDCx market: its address on /markets/$market. Compound names markets by the base asset
 * and the network ("usdc-mainnet"); here there is one network per deployment.
 */
export const MARKET_SLUG = 'usdcx-canton'

/** Asset in the first column: icon, symbol (and a badge next to it) and a caption under it. */
export function Asset({
  symbol,
  sub,
  badge,
}: {
  symbol: string
  sub?: ReactNode
  badge?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <TokenIcon symbol={symbol} className="size-8" />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold">
          <span className="truncate">{symbol}</span>
          {badge}
        </p>
        <p className="truncate text-xs text-muted-foreground">{sub ?? tokenName(symbol)}</p>
      </div>
    </div>
  )
}

/** Collateral asset status in words: absorbed collateral the protocol holds for sale. */
export function MarketFlags({ m }: { m: MarketView }) {
  if (isZero(m.protocolCollateral)) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <Badge variant="outline" className="font-normal">
        {formatAmount(m.protocolCollateral, tokenDigits(m.marketId))} held for sale
      </Badge>
    </div>
  )
}

/** Market total: label, value, a caption under it. */
export function Total({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/60 px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-lg font-semibold break-words">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}
    </div>
  )
}

/**
 * Borrow and supply APR by utilization: the shape of the rate model (pool.rateModel, K8):
 * borrow = kink model; supply = borrow × utilization × (1 − reserveFactor). Display of the model
 * only, like the old per-asset chart: the current rates shown as numbers come from the backend
 * (pool.borrowApr, pool.supplyApr); nothing here authorizes or moves money.
 */
export function RateChart({ p }: { p: PoolView }) {
  const m = p.rateModel
  const base = Number(m.baseRate)
  const s1 = Number(m.slope1)
  const s2 = Number(m.slope2)
  const rf = Math.min(Math.max(Number(m.reserveFactor) || 0, 0), 1)
  // The optimum is strictly inside (0, 1): otherwise division by zero gives NaN in the SVG (F-19)
  const rawOpt = Number(m.optimalUtilization)
  const opt = Number.isFinite(rawOpt) ? Math.min(Math.max(rawOpt, 0.01), 0.99) : 0.8
  const borrow = (u: number) =>
    u <= opt ? base + s1 * (u / opt) : base + s1 + s2 * ((u - opt) / (1 - opt))
  const supply = (u: number) => borrow(u) * u * (1 - rf)
  const top = borrow(1) > 0 && Number.isFinite(borrow(1)) ? borrow(1) : 1
  // Drawn at the width it gets, one SVG unit per pixel: labels keep their size on a phone and on
  // a full-width card alike (a fixed viewBox shrank them to 6px on a phone)
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(600)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      if (e) setW(Math.max(280, Math.round(e.contentRect.width)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const H = W >= 900 ? 260 : 220
  const pad = { l: 40, r: 16, t: 26, b: 26 }
  const x = (u: number) => pad.l + u * (W - pad.l - pad.r)
  const y = (r: number) => H - pad.b - (r / top) * (H - pad.t - pad.b)
  const steps = Array.from({ length: 41 }, (_, i) => i / 40)
  const line = (f: (u: number) => number, us: number[]) =>
    us.map((u) => `${x(u).toFixed(1)},${y(f(u)).toFixed(1)}`).join(' ')
  const rawCur = Number(p.utilization)
  const cur = Number.isFinite(rawCur) ? Math.min(Math.max(rawCur, 0), 1) : 0
  const maxU = Number(m.maxUtilization)
  const pct = (v: number) => `${Math.round(v * 100)}%`
  return (
    <figure className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
          Borrow APR
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-success" aria-hidden="true" />
          Earn APR
        </span>
      </div>
      <div ref={box}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          className="block max-w-full"
          role="img"
          aria-label={`Borrow APR ${pct(base)} at 0% utilization, ${pct(borrow(opt))} at the ${pct(opt)} optimum, ${pct(top)} at 100%. Earn APR is the borrow APR times utilization, less the ${pct(rf)} reserve factor. Now: utilization ${formatPercent(p.utilization, 1)}, borrow APR ${formatPercent(p.borrowApr)}, earn APR ${formatPercent(p.supplyApr)}; new loans stop at ${pct(maxU)}.`}
        >
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={pad.l}
                x2={W - pad.r}
                y1={y(top * f)}
                y2={y(top * f)}
                stroke="var(--border)"
              />
              <text
                x={pad.l - 6}
                y={y(top * f) + 3}
                textAnchor="end"
                fontSize="11"
                fill="var(--muted-foreground)"
              >
                {pct(top * f)}
              </text>
            </g>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((u) => (
            <text
              key={u}
              x={x(u)}
              y={H - 6}
              textAnchor="middle"
              fontSize="11"
              fill="var(--muted-foreground)"
            >
              {pct(u)}
            </text>
          ))}
          {Number.isFinite(maxU) && maxU > 0 && maxU < 1 && (
            <rect
              x={x(maxU)}
              y={pad.t}
              width={x(1) - x(maxU)}
              height={H - pad.t - pad.b}
              fill="var(--destructive)"
              opacity="0.06"
            />
          )}
          <line
            x1={x(opt)}
            x2={x(opt)}
            y1={pad.t}
            y2={H - pad.b}
            stroke="var(--muted-foreground)"
            strokeDasharray="3 3"
          />
          <text
            x={x(opt)}
            y={pad.t - 8}
            textAnchor="middle"
            fontSize="11"
            fill="var(--muted-foreground)"
          >
            Optimal {pct(opt)}
          </text>
          <line
            x1={x(cur)}
            x2={x(cur)}
            y1={pad.t}
            y2={H - pad.b}
            stroke="var(--primary)"
            strokeDasharray="3 3"
          />
          <text x={x(cur) + 4} y={pad.t + 10} fontSize="11" fill="var(--primary)">
            Now {formatPercent(p.utilization, 1)}
          </text>
          <polyline
            points={line(borrow, [0, opt, 1])}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <polyline
            points={line(supply, steps)}
            fill="none"
            stroke="var(--success)"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <circle
            cx={x(cur)}
            cy={y(borrow(cur))}
            r="4"
            fill="var(--primary)"
            stroke="var(--card)"
            strokeWidth="2"
          />
          <circle
            cx={x(cur)}
            cy={y(supply(cur))}
            r="4"
            fill="var(--success)"
            stroke="var(--card)"
            strokeWidth="2"
          />
        </svg>
      </div>
      <figcaption className="text-xs text-muted-foreground">
        Utilization is borrowed / supplied. Shaded: above {pct(maxU)} utilization new loans are
        blocked to keep withdrawals liquid.
      </figcaption>
    </figure>
  )
}
