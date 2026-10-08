import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useWallet } from '@/wallet/context'

/** How long a Loop account may take to appear after sign-in before we suggest signing in again. */
const LOOP_OPEN_MS = 30_000

/**
 * A Loop account opens on sign-in (the backend's ensureAccount), not with a separate request. Until
 * the account read catches up, say so and keep polling (useAccount refetches every 2 s); if it takes
 * too long, signing in again runs ensureAccount again.
 */
export function LoopAccountWait() {
  const wallet = useWallet()
  const [late, setLate] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLate(true), LOOP_OPEN_MS)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        {!late && <Spinner />}
        {late
          ? 'Your Loop account is still not open. Sign in again: the protocol opens it on sign-in.'
          : 'Opening your lending account: the protocol opens it on sign-in, this takes a few seconds.'}
      </p>
      {late && (
        <Button
          variant="outline"
          onClick={async () => {
            await wallet.disconnect()
            await wallet.connectLoop()
          }}
        >
          Sign in again
        </Button>
      )}
    </div>
  )
}
