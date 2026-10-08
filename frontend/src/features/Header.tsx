import { CopyIcon, ListIcon, MoonIcon, SignOutIcon, SunIcon, XIcon } from '@phosphor-icons/react'
import { loopPartyOf } from '@lending/shared'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { LoopIcon, Logo } from '@/components/brand'
import { CONTAINER } from '@/components/layout'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@/components/ui/navigation-menu'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ConnectButton } from './ConnectButton'
import { Hint } from './Hint'
import { MarketSelector } from './MarketSelector'
import { useGovernance, useNetworkLabel, useRoles } from '@/hooks/app'
import { middleParty } from '@/lib/amount'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useWallet } from '@/wallet/context'

interface NavItem {
  to: '/' | '/markets' | '/history' | '/liquidations' | '/admin' | '/council'
  label: string
}

/** Menu items: service ones only for their roles. */
function useNav(): NavItem[] {
  const wallet = useWallet()
  const roles = useRoles()
  const council = useGovernance()
  const items: NavItem[] = [
    { to: '/', label: 'Dashboard' },
    { to: '/markets', label: 'Markets' },
  ]
  if (wallet.signedIn && !roles.isService) items.push({ to: '/history', label: 'History' })
  if (roles.isLiquidator || roles.isBackstop)
    items.push({ to: '/liquidations', label: 'Buy collateral' })
  if (roles.isGuardian || roles.isTreasury) items.push({ to: '/admin', label: 'Admin' })
  if (council.data) items.push({ to: '/council', label: 'Council' })
  return items
}

export function Header() {
  const wallet = useWallet()
  const nav = useNav()
  const [menu, setMenu] = useState(false)
  const { theme, toggle } = useTheme()
  const network = useNetworkLabel().name

  // The full party id is long: show a short one, copy the whole on click
  // Loop account: the session is issued to subject loop:<party>, show and copy the party itself
  const shownParty = wallet.party ? (loopPartyOf(wallet.party) ?? wallet.party) : null
  const copyParty = async () => {
    if (!shownParty) return
    try {
      await navigator.clipboard.writeText(shownParty)
      toast.success('Party ID copied')
    } catch {
      toast.error('Could not copy the party ID')
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className={cn(CONTAINER, 'flex h-16 items-center gap-2 sm:gap-3')}>
        <Link
          to="/"
          className="mr-2 flex shrink-0 items-center gap-2 xl:mr-0"
          aria-label="Canton Lending home"
        >
          <Logo className="size-7" />
          <span className="font-display text-lg font-semibold tracking-tight max-[419px]:hidden">
            Canton Lending
          </span>
        </Link>
        {/* Below lg the market selector with the network moves into the menu: the network stays
            visible here, so a test network is never mistaken for the real one (review 08.10, item 7) */}
        {network && network !== 'MainNet' && (
          <Badge variant="warning" className="shrink-0 lg:hidden">
            {network}
          </Badge>
        )}

        {/* Menu centred in the free space: equal gaps to the logo and to the buttons on the right */}
        <NavigationMenu
          viewport={false}
          aria-label="Main"
          className="hidden max-w-none flex-1 justify-center xl:flex"
        >
          <NavigationMenuList className="gap-1 rounded-[14px] border bg-surface p-1">
            {nav.map((n) => (
              <NavigationMenuItem key={n.to} className="flex">
                <NavigationMenuLink asChild>
                  <Link
                    to={n.to}
                    activeOptions={{ exact: n.to === '/' }}
                    className="h-8 flex-row items-center rounded-lg px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:bg-accent data-[status=active]:bg-card data-[status=active]:text-foreground data-[status=active]:shadow-[0_1px_2px_rgb(15_23_42/0.08)] dark:data-[status=active]:bg-accent"
                  >
                    {n.label}
                  </Link>
                </NavigationMenuLink>
              </NavigationMenuItem>
            ))}
          </NavigationMenuList>
        </NavigationMenu>

        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2 xl:ml-0">
          {/* on a narrower screen the selector is the first row of the menu */}
          <MarketSelector className="hidden lg:inline-flex" />
          <Hint tip={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
            <Button
              variant="outline"
              size="icon"
              className="hidden size-9 sm:inline-flex"
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <SunIcon weight="bold" /> : <MoonIcon weight="bold" />}
            </Button>
          </Hint>

          {wallet.party ? (
            <>
              <Hint tip={<span className="break-all">{shownParty} (click to copy)</span>}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copyParty()}
                  className="group h-9 min-w-0 shrink gap-1.5 px-2.5 font-medium sm:w-36"
                >
                  {wallet.kind === 'loop' ? (
                    <LoopIcon className="size-5 rounded-[5px]" />
                  ) : (
                    <Avatar aria-hidden="true" className="size-5">
                      <AvatarFallback className="bg-primary text-[10px] font-semibold text-primary-foreground uppercase">
                        {wallet.party.charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <span className="sr-only">
                    {wallet.kind === 'loop' ? 'Loop account ' : 'Node wallet '}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[13px] tracking-tight">
                    {middleParty(shownParty ?? wallet.party)}
                  </span>
                  <span className="sr-only">, copy party ID</span>
                  <CopyIcon
                    weight="bold"
                    className="hidden size-3.5 text-muted-foreground group-hover:text-foreground sm:block"
                  />
                </Button>
              </Hint>
              {/* On a phone, a square icon button with the same name: aria-label */}
              <Button
                variant="outline"
                size="icon"
                className="sm:w-36 sm:px-3"
                aria-label="Disconnect"
                onClick={() => void wallet.disconnect()}
              >
                <SignOutIcon weight="bold" data-icon="inline-start" />
                <span className="hidden sm:inline">Disconnect</span>
              </Button>
            </>
          ) : (
            <ConnectButton size="sm" />
          )}

          <Sheet open={menu} onOpenChange={setMenu}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="size-9 xl:hidden"
                aria-label={menu ? 'Close menu' : 'Open menu'}
                aria-controls="mobile-nav"
              >
                {menu ? <XIcon weight="bold" /> : <ListIcon weight="bold" />}
              </Button>
            </SheetTrigger>
            <SheetContent
              id="mobile-nav"
              side="right"
              aria-describedby={undefined}
              className="gap-0 xl:hidden"
            >
              <SheetHeader>
                <SheetTitle>Menu</SheetTitle>
              </SheetHeader>
              <nav aria-label="Main" className="px-2">
                <MarketSelector className="mb-2 h-11 w-full justify-start px-3 text-[15px] lg:hidden" />
                <ul>
                  {nav.map((n) => (
                    <li key={n.to}>
                      <Link
                        to={n.to}
                        activeOptions={{ exact: n.to === '/' }}
                        onClick={() => setMenu(false)}
                        className="flex min-h-11 items-center rounded-md px-3 text-[15px] text-muted-foreground hover:bg-accent data-[status=active]:font-semibold data-[status=active]:text-foreground"
                      >
                        {n.label}
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="sm:hidden">
                  <Separator className="my-2" />
                  <Button
                    variant="ghost"
                    onClick={toggle}
                    className="min-h-11 w-full justify-start px-3 text-[15px] font-normal text-muted-foreground"
                  >
                    {theme === 'dark' ? (
                      <SunIcon weight="bold" data-icon="inline-start" />
                    ) : (
                      <MoonIcon weight="bold" data-icon="inline-start" />
                    )}
                    {theme === 'dark' ? 'Light theme' : 'Dark theme'}
                  </Button>
                </div>
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {wallet.error && (
        <p role="alert" className={cn(CONTAINER, 'pb-3 text-sm text-destructive')}>
          {wallet.error}
        </p>
      )}
    </header>
  )
}
