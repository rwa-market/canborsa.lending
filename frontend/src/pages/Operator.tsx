import { ShieldCheckIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { PageBody, PageTop } from '@/components/layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { useWallet } from '@/wallet/context'
import { nodeWalletEnabled } from '@/wallet/node'

/**
 * Login for protocol roles (guardian, treasury, liquidator, backstop, council) with a Canton
 * node account: their parties live on our node, Loop will not sign for them. Users log in
 * only with Loop ("Connect wallet"), so the page is not in the menu, and the node wallet is nowhere
 * except on it.
 */
export function OperatorPage() {
  const wallet = useWallet()
  return (
    <>
      <PageTop
        title="Protocol roles"
        description="Guardian, treasury, liquidator, backstop and council members sign in here."
      />
      <PageBody>
        <Card asChild className="max-w-lg gap-5">
          <section aria-label="Protocol roles sign-in">
            <CardHeader className="gap-4">
              <span className="flex size-10 items-center justify-center rounded-full bg-muted">
                <ShieldCheckIcon size={22} weight="duotone" aria-hidden="true" />
              </span>
              <div className="flex flex-col gap-1.5">
                <CardTitle asChild>
                  <h2 className="text-lg">Canton node account</h2>
                </CardTitle>
                <CardDescription asChild>
                  <p>
                    Role parties live on our Canton node, so they sign in with the node account. To
                    supply or borrow, connect Loop with Connect wallet instead.
                  </p>
                </CardDescription>
              </div>
            </CardHeader>
            <CardFooter>
              {nodeWalletEnabled() ? (
                <Button onClick={() => void wallet.connectNode()} disabled={wallet.connecting}>
                  {wallet.connecting && <Spinner data-icon="inline-start" />}
                  Sign in with Canton node
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">Node sign-in is not configured.</p>
              )}
            </CardFooter>
            {wallet.error && (
              <CardContent>
                <Alert variant="destructive">
                  <WarningCircleIcon weight="fill" />
                  <AlertDescription>{wallet.error}</AlertDescription>
                </Alert>
              </CardContent>
            )}
          </section>
        </Card>
      </PageBody>
    </>
  )
}
