import { LoopIcon } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConfig } from '@/hooks/data'
import { cn } from '@/lib/utils'
import { useWallet } from '@/wallet/context'
import { loopConfigOf } from '@/wallet/loop-config'
import { Hint } from './Hint'

/**
 * User login: straight to the Loop wallet (QR dialog or Loop popup), without a
 * picker dialog. Protocol roles log in with a node account on the /operator page.
 */
export function ConnectButton({
  size = 'default',
  className,
}: {
  size?: 'default' | 'sm'
  className?: string
}) {
  const wallet = useWallet()
  const config = useConfig()
  // Until /config arrives, it is unknown whether Loop is enabled
  if (!loopConfigOf(config.data)) return null
  return (
    <Hint tip="Sign in with the Loop wallet: in your browser or on your phone">
      <Button
        size={size}
        className={cn(size === 'sm' && 'h-9', className)}
        onClick={() => void wallet.connectLoop()}
        disabled={wallet.connecting}
        aria-busy={wallet.connecting}
      >
        {wallet.connecting ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <LoopIcon className="size-5 rounded-[5px] ring-1 ring-white/25" />
        )}
        {wallet.connecting ? 'Signing in…' : 'Connect wallet'}
      </Button>
    </Hint>
  )
}
