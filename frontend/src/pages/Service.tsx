import { PageBody, PageTop } from '@/components/layout'
import { Card, CardDescription } from '@/components/ui/card'
import { AdminPanel } from '@/features/AdminPanel'
import { History } from '@/features/History'
import { Liquidator } from '@/features/Liquidator'
import { Treasury } from '@/features/Treasury'
import { useRoles } from '@/hooks/app'
import { useWallet } from '@/wallet/context'

function NotForYou({ text }: { text: string }) {
  return (
    <Card className="p-6 shadow-none">
      <CardDescription asChild>
        <p>{text}</p>
      </CardDescription>
    </Card>
  )
}

/** Risk admin: guardian (five pause flags) and treasury (reserves). */
export function AdminPage() {
  const roles = useRoles()
  const allowed = roles.isGuardian || roles.isTreasury
  return (
    <>
      <PageTop
        title="Admin"
        description="The guardian pauses loans, withdrawals, liquidations and sales; the treasury adds reserves. Supply, repayments and collateral deposits always stay open."
      />
      <PageBody>
        {allowed ? (
          <div className="grid items-start gap-6 lg:grid-cols-2">
            {roles.isGuardian && <AdminPanel />}
            <Treasury />
          </div>
        ) : (
          <NotForYou text="This page is for the guardian and the treasury. Sign in with one of these roles." />
        )}
      </PageBody>
    </>
  )
}

/** Liquidators and the backstop buy absorbed collateral (K5) without seeing the borrower (§9). */
export function BuyCollateralPage() {
  const roles = useRoles()
  return (
    <>
      <PageTop
        title="Buy collateral"
        description="Collateral the protocol took from liquidated positions, sold at a discount to approved buyers. You never see whose position it was."
      />
      <PageBody>
        {roles.isLiquidator || roles.isBackstop ? (
          <div className="max-w-3xl">
            <Liquidator />
          </div>
        ) : (
          <NotForYou text="This page is for approved liquidators and the backstop." />
        )}
      </PageBody>
    </>
  )
}

export function HistoryPage() {
  const wallet = useWallet()
  return (
    <>
      <PageTop
        title="Transaction history"
        description="Your operations on the protocol, newest first."
      />
      <PageBody>
        {wallet.party && wallet.signedIn ? (
          <div className="max-w-4xl">
            <History />
          </div>
        ) : (
          <NotForYou text="Connect a wallet to see your history." />
        )}
      </PageBody>
    </>
  )
}
