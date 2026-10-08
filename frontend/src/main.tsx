import { IconContext } from '@phosphor-icons/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError } from '@/lib/api'
import { WalletProvider } from '@/wallet/context'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './router.tsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // a retry does not fix 401/403: the handler in api.ts resets the session (F-8)
      retry: (count, e) => count < 1 && !(e instanceof ApiError && [401, 403].includes(e.status)),
      refetchOnWindowFocus: true,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* Icons are decorative: the meaning is always carried by nearby text or the button's aria-label */}
        <IconContext.Provider value={{ 'aria-hidden': true, focusable: false }}>
          <TooltipProvider>
            <WalletProvider>
              <RouterProvider router={router} />
              <Toaster />
            </WalletProvider>
          </TooltipProvider>
        </IconContext.Provider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
