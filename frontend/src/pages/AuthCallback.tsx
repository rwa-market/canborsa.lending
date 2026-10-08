import { WarningCircleIcon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { shortParty } from '@/lib/amount'
import { useConfig } from '@/hooks/data'
import { useWallet } from '@/wallet/context'
import { nodeCompleteLogin, nodeParties } from '@/wallet/node'
import { api } from '@/lib/api'
import { liveSession, rememberedWallet } from '@/wallet/session'

/**
 * Party labels for the picker: the account's main party and the protocol roles from /config.
 * The account's other parties (deployment service parties, former test wallets)
 * are collapsed: you can log in with them, but they are not in the default list.
 */
export function partyChoices(
  parties: string[],
  roles: Partial<Record<'guardian' | 'treasury' | 'backstop', string>> & {
    liquidators?: string[]
    liquidator?: string
  } = {},
): { party: string; label: string }[] {
  const label = new Map<string, string>()
  const add = (p: string | undefined, l: string) => {
    if (p && !label.has(p)) label.set(p, l)
  }
  add(roles.guardian, 'Guardian')
  add(roles.treasury, 'Treasury')
  for (const l of roles.liquidators ?? (roles.liquidator ? [roles.liquidator] : []))
    add(l, 'Liquidator')
  add(roles.backstop, 'Backstop')
  // council members: deployment parties lending-CouncilMember<n>
  for (const p of parties) {
    const m = /-CouncilMember(\d+)::/.exec(p)
    if (m) add(p, `Council member ${m[1]}`)
  }
  return [...label].filter(([p]) => parties.includes(p)).map(([party, l]) => ({ party, label: l }))
}

/**
 * Return from the node OIDC login: exchange the code for a token (in memory), pick a party and log
 * in to the protocol with a Login signature. If this party already had a session (page reload),
 * just restore it.
 */
export function AuthCallbackPage() {
  const wallet = useWallet()
  const navigate = useNavigate()
  const started = useRef(false)
  const [next, setNext] = useState('/')
  const [parties, setParties] = useState<string[] | null>(null)
  const roles = useConfig().data?.roles
  const choices = useMemo(() => partyChoices(parties ?? [], roles), [parties, roles])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      try {
        const to = await nodeCompleteLogin(window.location.search)
        setNext(to)
        const { parties: all } = await nodeParties()
        // the protocol cookie session survived the reload: log in as the same party without picking
        const saved = liveSession(await api.session().catch(() => null))
        const again =
          saved && rememberedWallet() === 'node' && all.includes(saved.party) ? saved.party : null
        const only = all.length === 1 ? all[0]! : null
        const pick = again ?? only
        if (pick) {
          await wallet.connectNode(pick)
          void navigate({ to, replace: true })
        } else if (all.length === 0) setParties([])
        else setParties(all)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // silent login without a node session: just stay a guest
        if (/sign in to the node wallet/.test(msg)) void navigate({ to: '/', replace: true })
        else setError(msg)
      }
    })()
  }, [wallet, navigate])

  const choose = async (p: string) => {
    await wallet.connectNode(p)
    void navigate({ to: next, replace: true })
  }

  const home = (
    <CardFooter>
      <Button variant="outline" onClick={() => void navigate({ to: '/' })}>
        Back to the dashboard
      </Button>
    </CardFooter>
  )

  return (
    <>
      <PageTop title="Protocol roles" description="Signing in with the Canton node account." />
      <PageBody>
        <Card asChild className="max-w-lg gap-5">
          <section aria-label="Node wallet sign-in">
            {error ? (
              <>
                <CardHeader>
                  <CardTitle asChild>
                    <h2 className="text-lg">Sign-in failed</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Alert variant="destructive">
                    <WarningCircleIcon weight="fill" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                </CardContent>
                {home}
              </>
            ) : parties === null ? (
              <CardContent>
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner />
                  Signing you in…
                </p>
              </CardContent>
            ) : choices.length === 0 ? (
              <>
                <CardHeader>
                  <CardTitle asChild>
                    <h2 className="text-lg">No protocol role on this account</h2>
                  </CardTitle>
                  <CardDescription asChild>
                    <p>
                      This sign-in is for the guardian, treasury, liquidators, backstop and council.
                      To supply or borrow, use Connect wallet.
                    </p>
                  </CardDescription>
                </CardHeader>
                {home}
              </>
            ) : (
              <>
                <CardHeader>
                  <CardTitle asChild>
                    <h2 className="text-lg">Choose a role</h2>
                  </CardTitle>
                  <CardDescription asChild>
                    <p>Your node account holds these protocol roles.</p>
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <ul className="divide-y rounded-lg border">
                    {choices.map(({ party, label }) => (
                      <PartyRow
                        key={party}
                        party={party}
                        label={label}
                        disabled={wallet.connecting}
                        onChoose={choose}
                      />
                    ))}
                  </ul>
                  {wallet.error && (
                    <Alert variant="destructive">
                      <WarningCircleIcon weight="fill" />
                      <AlertDescription>{wallet.error}</AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </>
            )}
          </section>
        </Card>
      </PageBody>
    </>
  )
}

function PartyRow({
  party,
  label,
  disabled,
  onChoose,
}: {
  party: string
  label?: string
  disabled: boolean
  onChoose: (p: string) => Promise<void>
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="mr-auto min-w-0 truncate text-sm font-medium">
            {label ?? shortParty(party)}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-all">{party}</TooltipContent>
      </Tooltip>
      <Button
        size="sm"
        disabled={disabled}
        aria-label={`Sign in as ${party.split('::')[0]}`}
        onClick={() => void onChoose(party)}
      >
        Sign in
      </Button>
    </li>
  )
}
