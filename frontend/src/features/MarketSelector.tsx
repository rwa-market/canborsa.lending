import type { TokenSymbol } from '@lending/shared'
import { CaretDownIcon, CaretRightIcon, CheckIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { TokenIcon } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useNetworkLabel } from '@/hooks/app'
import { cn } from '@/lib/utils'
import { MARKET_SLUG } from './market/parts'

interface MarketEntry {
  slug: string
  symbol: TokenSymbol
}

interface NetworkEntry {
  id: string
  name: string
  /** token icon that stands for the network */
  icon: TokenSymbol
  markets: MarketEntry[]
}

/**
 * Networks and their markets. A deployment serves one network with one USDCx market, so the list
 * has one entry of each; the selector takes any number.
 */
function useNetworks(): NetworkEntry[] {
  const network = useNetworkLabel().name
  return [
    {
      id: 'canton',
      name: `Canton${network ? ` ${network}` : ''}`,
      icon: 'CC',
      markets: [{ slug: MARKET_SLUG, symbol: 'USDCx' }],
    },
  ]
}

const ROW =
  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[15px] font-semibold transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none'

const CAPTION = 'px-3 pt-2 pb-1.5 text-xs font-medium text-muted-foreground'

/**
 * Market selector in the header, as on app.compound.xyz: the current market on the button;
 * networks on the left of the menu, the markets of the chosen network on the right.
 */
export function MarketSelector({ className }: { className?: string }) {
  const networks = useNetworks()
  // the market this deployment serves is the selected one
  const current = { network: networks[0]!, market: networks[0]!.markets[0]! }
  const [open, setOpen] = useState(false)
  const [networkId, setNetworkId] = useState(current.network.id)
  const shown = networks.find((n) => n.id === networkId) ?? current.network
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 min-w-0 gap-2 px-2.5 font-semibold', className)}
        >
          <span className="flex shrink-0 items-center">
            <TokenIcon symbol={current.market.symbol} className="size-5" />
            <TokenIcon symbol={current.network.icon} className="-ml-1 size-5 ring-2 ring-card" />
          </span>
          {current.market.symbol}
          <span className="truncate font-medium text-muted-foreground">{current.network.name}</span>
          <CaretDownIcon
            weight="bold"
            className={cn(
              'ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-label="Select a market"
        // two columns under the header button; in the phone menu, one column as wide as the button
        className="grid w-(--radix-popover-trigger-width) gap-2 rounded-xl p-2 lg:w-[30rem] lg:grid-cols-[1.15fr_1fr] lg:gap-0"
      >
        {/* both columns start with a caption, so their first rows sit on one line */}
        <div className="lg:border-r lg:pr-2">
          <p className={CAPTION}>Network</p>
          <ul role="list" aria-label="Networks" className="flex flex-col gap-1">
            {networks.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  aria-pressed={n.id === shown.id}
                  onClick={() => setNetworkId(n.id)}
                  className={cn(ROW, 'aria-pressed:bg-accent')}
                >
                  <TokenIcon symbol={n.icon} className="size-7" />
                  <span className="min-w-0 flex-1 truncate">{n.name}</span>
                  <span className="text-sm font-medium text-muted-foreground">
                    {n.markets.length}
                  </span>
                  <CaretRightIcon weight="bold" className="size-3.5 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:pl-2">
          <p className={CAPTION}>Markets</p>
          <ul role="list" aria-label={`Markets on ${shown.name}`} className="flex flex-col gap-1">
            {shown.markets.map((m) => {
              const selected = shown.id === current.network.id && m.slug === current.market.slug
              return (
                <li key={m.slug}>
                  <button
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => setOpen(false)}
                    className={ROW}
                  >
                    <TokenIcon symbol={m.symbol} className="size-7" />
                    <span className="min-w-0 flex-1 truncate">{m.symbol}</span>
                    {selected && (
                      <CheckIcon weight="bold" className="size-4 shrink-0 text-success" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}
