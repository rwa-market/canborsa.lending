import type { ReactNode } from 'react'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** App mark: the same file as the favicon. */
export function Logo({ className }: { className?: string }) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      className={cn('size-8 object-contain', className)}
    />
  )
}

/** Loop Wallet mark: light-blue and lime diamonds on a dark tile. */
export function LoopIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-5', className)} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#0e0e0e" />
      <rect
        x="7.55"
        y="9.45"
        width="13.1"
        height="13.1"
        rx="2.6"
        fill="#a8e2fb"
        transform="rotate(45 14.1 16)"
      />
      <rect
        x="13.2"
        y="10.05"
        width="11.55"
        height="11.55"
        rx="2.3"
        fill="#f5ffa3"
        stroke="#0e0e0e"
        strokeWidth="1.1"
        transform="rotate(45 18.98 15.83)"
      />
    </svg>
  )
}

/** Token logos: USDCx is the USDC mark, CC is Canton Coin, CBTC is BitSafe (CoinGecko). */
const TOKENS: Record<string, string> = {
  USDCx: '/tokens/usdcx.svg',
  CC: '/tokens/cc.png',
  CBTC: '/tokens/cbtc.png',
}

/** Round token icon; an unknown symbol gets its first letter. */
export function TokenIcon({ symbol, className }: { symbol: string; className?: string }) {
  const src = TOKENS[symbol]
  if (src)
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={cn('size-9 shrink-0 rounded-full object-cover', className)}
      />
    )
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted-foreground/40',
        className,
      )}
    >
      <span className="text-xs font-bold text-white">{symbol.charAt(0)}</span>
    </span>
  )
}

/** Section card: shadcn Card as `<section>`, thin border, padding for the section header. */
export function Panel({ className, children, ...props }: React.ComponentProps<'section'>) {
  return (
    <Card asChild className={cn('gap-5 p-5 sm:p-6', className)}>
      <section {...props}>{children}</section>
    </Card>
  )
}

/** Section header: CardHeader with a title (`<h2>`), caption and an action on the right. */
export function SectionTitle({
  title,
  hint,
  action,
  id,
}: {
  title: string
  hint?: string
  action?: ReactNode
  /** header id: the section references it via aria-labelledby */
  id?: string
}) {
  return (
    <CardHeader className="gap-1 px-0">
      <CardTitle asChild>
        <h2 id={id} className="text-lg leading-tight">
          {title}
        </h2>
      </CardTitle>
      {hint && (
        <CardDescription asChild>
          <p className="max-w-[62ch]">{hint}</p>
        </CardDescription>
      )}
      {action && <CardAction>{action}</CardAction>}
    </CardHeader>
  )
}

/** Label and value: labels in normal case, values in the numeric font. */
export function Figure({
  label,
  value,
  sub,
  className,
}: {
  label: string
  value: ReactNode
  sub?: string
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-semibold break-words">
        {value}
        {sub && (
          <span className="block text-xs font-normal text-muted-foreground sm:ml-1 sm:inline">
            {sub}
          </span>
        )}
      </dd>
    </div>
  )
}

/** Thin fill bar with a share in percent (display, not money). */
export function Meter({
  value,
  tone = 'brand',
  label,
  valueText,
}: {
  value: number
  tone?: 'brand' | 'warn' | 'bad'
  label: string
  /** What to read out instead of a bare percentage, e.g. "$1,200 of $5,000" */
  valueText?: string
}) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueText ? `${Math.round(v)}%, ${valueText}` : undefined}
      className="h-1.5 rounded-full bg-muted"
    >
      <div
        data-slot="meter-fill"
        className={cn(
          'h-full rounded-full transition-[width] duration-700 ease-spring',
          tone === 'brand' && 'bg-primary',
          tone === 'warn' && 'bg-warning',
          tone === 'bad' && 'bg-destructive',
        )}
        style={{ width: `${v > 0 ? Math.max(v, 2) : 0}%` }}
      />
    </div>
  )
}
