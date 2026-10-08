import {
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  Link,
  lazyRouteComponent,
  Outlet,
  ScrollRestoration,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import { ActionProvider, useAction } from '@/features/action'
import { ActionDialog } from '@/features/ActionDialog'
import { Header } from '@/features/Header'
import { NodeConfirm, SigningNotice } from '@/features/SigningNotice'
import { DashboardPage } from '@/pages/Dashboard'
import { MarketsPage } from '@/pages/Markets'
import { MarketPage } from '@/pages/Market'
import { NotFound } from '@/features/NotFound'
import { PageBody, PageTop } from '@/components/layout'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/** Build label on the shell (`data-build`), not on screen: a stale bundle is still easy to spot (F-17). */
const BUILD = import.meta.env.VITE_BUILD_ID || 'dev'

/** Page render error: a message and a way out, not a white screen (F-19). */
function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <>
      <PageTop title="Something went wrong" description="This page failed to render." />
      <PageBody>
        <Alert variant="destructive" className="max-w-2xl">
          <WarningCircleIcon weight="fill" />
          <AlertTitle>The page stopped with an error</AlertTitle>
          <AlertDescription className="gap-3">
            <p>{error instanceof Error ? error.message : String(error)}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={reset}>
                Try again
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link to="/">Go to dashboard</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </PageBody>
    </>
  )
}

/** Tab title per page: a screen reader and the browser history tell the pages apart. */
const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Dashboard'],
  [/^\/markets\/[^/]+$/, 'USDCx market'],
  [/^\/markets$/, 'Markets'],
  [/^\/history$/, 'History'],
  [/^\/liquidations$/, 'Buy collateral'],
  [/^\/admin$/, 'Admin'],
  [/^\/council$/, 'Council'],
  [/^\/operator$/, 'Service sign-in'],
]

/** Page title and the action dialog follow the route: the dialog does not outlive its page. */
function RouteEffects() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const { setOpen } = useAction()
  useEffect(() => {
    const page = TITLES.find(([re]) => re.test(path))?.[1]
    document.title = page ? `${page} · Canton Lending` : 'Canton Lending'
    setOpen(false)
  }, [path, setOpen])
  return null
}

/** App shell: header with navigation and the page. */
function Shell() {
  return (
    <ActionProvider>
      <div data-build={BUILD} className="flex min-h-screen flex-col">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <RouteEffects />
        <Header />
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          <Outlet />
        </main>
        <ActionDialog />
        <SigningNotice />
        <NodeConfirm />
        <ScrollRestoration />
      </div>
    </ActionProvider>
  )
}

const root = createRootRoute({ component: Shell, notFoundComponent: NotFound })

// Rare pages as separate chunks: the main bundle is lighter (F-17)
const service = (name: 'AdminPage' | 'HistoryPage' | 'BuyCollateralPage') =>
  lazyRouteComponent(() => import('@/pages/Service'), name)

const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: '/', component: DashboardPage }),
  createRoute({ getParentRoute: () => root, path: '/markets', component: MarketsPage }),
  createRoute({ getParentRoute: () => root, path: '/markets/$market', component: MarketPage }),
  createRoute({ getParentRoute: () => root, path: '/history', component: service('HistoryPage') }),
  createRoute({
    getParentRoute: () => root,
    path: '/liquidations',
    component: service('BuyCollateralPage'),
  }),
  createRoute({ getParentRoute: () => root, path: '/admin', component: service('AdminPage') }),
  createRoute({
    getParentRoute: () => root,
    path: '/operator',
    component: lazyRouteComponent(() => import('@/pages/Operator'), 'OperatorPage'),
  }),
  createRoute({
    getParentRoute: () => root,
    path: '/auth/callback',
    component: lazyRouteComponent(() => import('@/pages/AuthCallback'), 'AuthCallbackPage'),
  }),
  createRoute({
    getParentRoute: () => root,
    path: '/council',
    component: lazyRouteComponent(() => import('@/pages/Council'), 'CouncilPage'),
  }),
])

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFound,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
