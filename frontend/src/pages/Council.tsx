import type { GovernanceView } from '@lending/shared'
import {
  PlusIcon,
  ScalesIcon,
  WalletIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Panel, SectionTitle } from '@/components/brand'
import { PageBody, PageTop } from '@/components/layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IncomeForm, ProposalForm, RotationForm, type Submission } from '@/features/council/Forms'
import {
  type Busy,
  FullValue,
  IncomeList,
  ProposalList,
  RotationList,
  type RunAction,
} from '@/features/council/Items'
import { accessOf, actionIntent, approvalsWord, decmanState } from '@/features/council/model'
import { useGovernance, useNetworkBlocked } from '@/hooks/app'
import { notifyError, submitWithRetry, useConfig, usePool } from '@/hooks/data'
import { api, ApiError, queryKeys } from '@/lib/api'
import { shortParty } from '@/lib/amount'
import { useWallet } from '@/wallet/context'

const DONE: Record<string, string> = {
  approve: 'Approved',
  execute: 'Executed on ledger',
  join: 'You joined the new council',
  withdraw: 'Withdrawn',
}

/** Clock for deadlines: an expired proposal loses its buttons without a reload. */
function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function roleOf(view: GovernanceView, me: string | null): string {
  const a = accessOf(view, me)
  if (a.member) return 'Council member'
  if (a.decman) return 'BitSafe member'
  if (a.treasury) return 'Treasury'
  if (a.operator) return 'Operator'
  if (a.incoming) return 'Joining member'
  return 'Viewer'
}

/** Page without data: who it is for and what to do. */
function Notice({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <Empty variant="card">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/**
 * Review item 25: the council seat belongs to a BitSafe Decentralized Party. Its members vote in
 * the Decentralization Manager on their own nodes; here they see what is pending and how many
 * confirmations each action has. The DecMan description is the readable "old -> new" diff.
 */
function DecManActions({
  decman,
  me,
}: {
  decman: NonNullable<GovernanceView['decman']>
  me: string | null
}) {
  return (
    <Panel aria-label="BitSafe Decentralized Party" className="gap-3">
      <SectionTitle
        title="BitSafe Decentralized Party"
        hint={`The council seat is held by a party of ${decman.members.length} members. An action executes after ${decman.threshold} of them confirm it in DecMan, each on their own node.`}
      />
      {decman.actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No DecMan actions are pending.</p>
      ) : (
        <ul className="-mt-1 divide-y text-sm">
          {decman.actions.map((a) => {
            const st = decmanState(a.confirmations.length, decman.threshold)
            return (
              <li key={a.contractId} className="flex min-w-0 flex-col gap-1.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.label}</span>
                  <Badge variant={st.tone === 'ready' ? 'success' : 'secondary'}>{st.label}</Badge>
                  {me && a.confirmations.includes(me) && (
                    <Badge variant="info">You confirmed</Badge>
                  )}
                </div>
                <p className="break-words text-muted-foreground">{a.description}</p>
                <p className="text-xs text-muted-foreground">
                  Proposed by {a.proposer === me ? 'you' : shortParty(a.proposer)}
                </p>
              </li>
            )
          })}
        </ul>
      )}
      {me && decman.members.includes(me) && (
        <p className="text-xs text-muted-foreground">
          You vote in the DecMan app on your node, not on this page: the buttons here belong to the
          council party itself.
        </p>
      )}
    </Panel>
  )
}

/** New proposal: the form expands on a button click so the list stays primary. */
function Composer({
  label,
  children,
}: {
  label: string
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!open)
    return (
      <Button variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
        <PlusIcon weight="bold" />
        {label}
      </Button>
    )
  return (
    <Panel aria-label={label} className="gap-4">
      <div className="flex items-center">
        <h2 className="mr-auto text-base font-semibold">{label}</h2>
        <Button size="icon" variant="ghost" aria-label="Close" onClick={() => setOpen(false)}>
          <XIcon weight="bold" />
        </Button>
      </div>
      {children(() => setOpen(false))}
    </Panel>
  )
}

/**
 * k-of-n council (lending-governance 0.4.0): parameter and role proposals, council rotation,
 * revenue withdrawal. Each command is assembled by the backend, checked by the verifier (F-1)
 * and signed by a council member's or treasury's wallet.
 */
export function CouncilPage() {
  const wallet = useWallet()
  const gov = useGovernance()
  const pool = usePool()
  const config = useConfig()
  const qc = useQueryClient()
  const now = useNow()
  const { blocked: networkBlocked, reason } = useNetworkBlocked()
  const me = wallet.signedIn ? wallet.party : null

  const act = useMutation({
    mutationFn: (s: Submission & { busy?: Busy }) =>
      submitWithRetry(wallet, async () => ({ prepared: await s.build(), intent: s.intent })),
    onSuccess: async (_r, s) => {
      toast.success(s.done)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['governance'] }),
        qc.invalidateQueries({ queryKey: queryKeys.pool }),
        qc.invalidateQueries({ queryKey: queryKeys.config }),
      ])
    },
    onError: (e) => notifyError(e),
  })

  const view = gov.data
  const forbidden = gov.error instanceof ApiError && gov.error.status === 403
  const access = view ? accessOf(view, me) : null
  const disabled = act.isPending || networkBlocked
  const busy = act.isPending ? (act.variables?.busy ?? null) : null

  const run: RunAction = (kind, contractId, action) => {
    if (!view || !me) return
    act.mutate({
      build: () => api.governanceAction(kind, contractId, action, me),
      intent: actionIntent(kind, action, contractId, view.roles.treasury),
      done: DONE[action] ?? 'Done',
      busy: { contractId, action },
    })
  }
  const submitForm = (close: () => void) => (s: Submission, reset: () => void) =>
    act.mutate(s, {
      onSuccess: () => {
        reset()
        close()
      },
    })

  const open = view ? view.proposals.length + view.rotations.length + view.income.length : 0

  return (
    <>
      <PageTop
        title="Council"
        description="Protocol parameters, roles and income change only through proposals the council approves by threshold. Every member signs with their own wallet."
        stats={
          view
            ? [
                {
                  label: 'Council',
                  value: view.decman
                    ? `BitSafe ${view.decman.threshold} of ${view.decman.members.length}`
                    : view.council
                      ? `${view.council.threshold} of ${view.council.members.length}`
                      : 'Not formed',
                },
                { label: 'Open items', value: String(open) },
                { label: 'You', value: roleOf(view, me) },
              ]
            : undefined
        }
      />
      <PageBody>
        {!wallet.signedIn ? (
          <Notice
            icon={<WalletIcon />}
            title="Sign in to see the council"
            text="Connect the wallet of a council member, the treasury or the operator."
          />
        ) : forbidden ? (
          <Notice
            icon={<ScalesIcon />}
            title="No council role on this wallet"
            text="This page is for council members, the treasury and the operator."
          />
        ) : !view ? (
          gov.error ? (
            <Alert variant="destructive">
              <WarningCircleIcon weight="fill" />
              <AlertTitle>Could not load the council</AlertTitle>
              <AlertDescription className="gap-3">
                <p>{gov.error.message}</p>
                <Button size="sm" onClick={() => void gov.refetch()}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <Skeleton className="h-64 w-full rounded-xl" label="Loading the council" />
          )
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col gap-4">
              {networkBlocked && (
                <Alert role="alert" variant="warning">
                  <WarningIcon weight="fill" />
                  <AlertDescription>
                    {reason ?? 'Switch your wallet network to sign.'}
                  </AlertDescription>
                </Alert>
              )}
              {view.decman && <DecManActions decman={view.decman} me={me} />}
              <Tabs defaultValue="proposals">
                <TabsList aria-label="Council items" className="w-full sm:w-fit">
                  <TabsTrigger value="proposals">Proposals ({view.proposals.length})</TabsTrigger>
                  <TabsTrigger value="rotations">Council ({view.rotations.length})</TabsTrigger>
                  <TabsTrigger value="income">Income ({view.income.length})</TabsTrigger>
                </TabsList>
                <TabsContent value="proposals" className="mt-3 flex flex-col gap-4">
                  <ProposalList
                    view={view}
                    me={me}
                    now={now}
                    busy={busy}
                    disabled={disabled}
                    run={run}
                  />
                  {access?.member && me && (
                    <Composer label="New proposal">
                      {(close) => (
                        <ProposalForm
                          view={view}
                          pool={pool.data}
                          party={me}
                          pending={disabled}
                          onSubmit={submitForm(close)}
                        />
                      )}
                    </Composer>
                  )}
                </TabsContent>
                <TabsContent value="rotations" className="mt-3 flex flex-col gap-4">
                  <RotationList
                    view={view}
                    me={me}
                    now={now}
                    busy={busy}
                    disabled={disabled}
                    run={run}
                  />
                  {access?.member && me && (
                    <Composer label="New council rotation">
                      {(close) => (
                        <RotationForm
                          view={view}
                          pool={pool.data}
                          party={me}
                          pending={disabled}
                          onSubmit={submitForm(close)}
                        />
                      )}
                    </Composer>
                  )}
                </TabsContent>
                <TabsContent value="income" className="mt-3 flex flex-col gap-4">
                  <IncomeList
                    view={view}
                    me={me}
                    now={now}
                    busy={busy}
                    disabled={disabled}
                    run={run}
                  />
                  {access?.member && me && (
                    <Composer label="New income proposal">
                      {(close) => (
                        <IncomeForm
                          view={view}
                          pool={pool.data}
                          party={me}
                          pending={disabled}
                          treasury={config.data?.roles.treasury}
                          onSubmit={submitForm(close)}
                        />
                      )}
                    </Composer>
                  )}
                </TabsContent>
              </Tabs>
            </div>

            <Panel aria-label="Council members" className="gap-4">
              <SectionTitle
                title="Members"
                hint={
                  view.decman
                    ? `The BitSafe party below holds the seat; ${view.decman.threshold} of its ${view.decman.members.length} members confirm each action.`
                    : view.council
                      ? `${view.council.threshold} ${approvalsWord(view.council.threshold)} execute${view.council.threshold === 1 ? 's' : ''} a proposal.`
                      : 'No council controls the protocol yet: the operator forms the first one.'
                }
              />
              {view.council && (
                <ul className="-mt-2 divide-y text-sm">
                  {view.council.members.map((m) => (
                    <li key={m} className="flex min-w-0 items-center gap-2 py-2">
                      <FullValue value={m} className="truncate">
                        {shortParty(m)}
                      </FullValue>
                      {m === me && (
                        <Badge variant="info" className="ml-auto">
                          You
                        </Badge>
                      )}
                      {m === view.decman?.governanceParty && (
                        <Badge variant="secondary" className="ml-auto">
                          BitSafe party
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {view.decman && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    BitSafe party members, {view.decman.threshold} of {view.decman.members.length}
                  </p>
                  <ul className="divide-y rounded-lg bg-muted/60 px-3 text-sm">
                    {view.decman.members.map((m) => (
                      <li key={m} className="flex min-w-0 items-center gap-2 py-2">
                        <FullValue value={m} className="truncate">
                          {m === me ? 'You' : shortParty(m)}
                        </FullValue>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">Protocol roles</p>
                <dl className="divide-y rounded-lg bg-muted/60 px-3 text-sm">
                  {(
                    [
                      ['Operator', [view.roles.operator]],
                      ['Oracle', [view.roles.oracle]],
                      ['Guardian', [view.roles.guardian]],
                      ['Treasury', [view.roles.treasury]],
                      ['Backstop', [view.roles.backstop]],
                      ['Liquidators', view.roles.liquidators],
                    ] as const
                  ).map(([label, parties]) => (
                    <div key={label} className="flex items-baseline justify-between gap-3 py-2">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="min-w-0 text-right">
                        {parties.map((p) => (
                          <FullValue key={p} value={p} className="block truncate">
                            {p === me ? 'You' : shortParty(p)}
                          </FullValue>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Panel>
          </div>
        )}
      </PageBody>
    </>
  )
}
