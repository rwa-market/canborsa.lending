import type {
  CouncilRotationView,
  GovernanceChange,
  GovernanceProposalView,
  GovernanceView,
  IncomeProposalView,
} from '@lending/shared'
import { CheckIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { TokenIcon } from '@/components/brand'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatAmount, isZero, shortParty } from '@/lib/amount'
import { cn } from '@/lib/utils'
import type { GovernanceAction, GovernanceKind } from '@/lib/api'
import {
  type Action,
  type ChangeRow,
  changeRows,
  incomeActions,
  incomeState,
  type ItemState,
  missingJoins,
  proposalActions,
  proposalState,
  rotationActions,
  rotationState,
} from './model'
import { formatDateTime } from '@/lib/dates'

export type RunAction = (kind: GovernanceKind, contractId: string, action: GovernanceAction) => void

/** Which action is being signed now: its button spins, the others wait. */
export interface Busy {
  contractId: string
  action: GovernanceAction
}

const TONE = {
  wait: 'outline',
  ready: 'success',
  done: 'info',
  blocked: 'warning',
} as const satisfies Record<ItemState['tone'], string>

/**
 * The full value (party id, contract id) goes in the tooltip: the screen shows the short form.
 * focusable: the tooltip opens from the keyboard too; small chips do not need focus.
 */
export function FullValue({
  value,
  children,
  className,
  focusable = true,
}: {
  value: string
  children: ReactNode
  className?: string
  focusable?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={focusable ? 0 : undefined}
          className={cn(
            'rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-all">{value}</TooltipContent>
    </Tooltip>
  )
}

function StateBadge({ state }: { state: ItemState }) {
  return (
    <Badge
      variant={TONE[state.tone]}
      className={cn(state.tone === 'wait' && 'text-muted-foreground')}
    >
      {state.label}
    </Badge>
  )
}

const Party = ({ party, me }: { party: string; me: string | null }) => (
  <FullValue value={party} className="font-medium">
    {party === me ? 'You' : shortParty(party)}
  </FullValue>
)

/**
 * Council seats: one per member, filled means approved. The mark after the k-th seat is the threshold:
 * shows how many signatures remain before execution.
 */
function Seats({
  members,
  signed,
  threshold,
  me,
  label,
}: {
  members: string[]
  signed: string[]
  threshold: number
  me: string | null
  label: string
}) {
  if (members.length === 0) return null
  const count = members.filter((m) => signed.includes(m)).length
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">
        {label}: {count} of {members.length}
        {threshold > 0 ? `, ${threshold} needed` : ''}
      </p>
      <ul aria-label={label} className="flex flex-wrap items-center gap-1.5">
        {members.map((m, i) => {
          const yes = signed.includes(m)
          return (
            <Tooltip key={m}>
              <TooltipTrigger asChild>
                <Badge
                  asChild
                  variant={yes ? 'success' : 'outline'}
                  className={cn(
                    'h-7 gap-1.5 pr-2.5 pl-1 font-normal',
                    !yes && 'border-dashed',
                    // threshold: gap after the k-th seat
                    threshold > 0 && i === threshold - 1 && i < members.length - 1 && 'mr-3',
                  )}
                >
                  <li>
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-5 items-center justify-center rounded-full',
                        yes ? 'bg-success text-success-foreground' : 'bg-muted',
                      )}
                    >
                      {yes && <CheckIcon size={12} weight="bold" />}
                    </span>
                    {m === me ? 'You' : shortParty(m)}
                    <span className="sr-only">{yes ? ', signed' : ', not yet'}</span>
                  </li>
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs break-all">{m}</TooltipContent>
            </Tooltip>
          )
        })}
      </ul>
    </div>
  )
}

function Actions({
  kind,
  contractId,
  actions,
  busy,
  disabled,
  run,
  what,
}: {
  kind: GovernanceKind
  contractId: string
  actions: Action[]
  busy: Busy | null
  disabled: boolean
  run: RunAction
  what: string
}) {
  if (actions.length === 0) return null
  return (
    <>
      <Separator />
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => {
          const spinning = busy?.contractId === contractId && busy.action === a.action
          return (
            <Button
              key={a.action}
              size="sm"
              variant={
                a.action === 'withdraw' ? 'ghost' : a.action === 'approve' ? 'outline' : 'default'
              }
              disabled={disabled}
              aria-busy={spinning}
              aria-label={`${a.label}: ${what}`}
              onClick={() => run(kind, contractId, a.action)}
            >
              {spinning && <Spinner data-icon="inline-start" />}
              {a.label}
            </Button>
          )
        })}
      </div>
    </>
  )
}

function Meta({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="truncate">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const when = (iso: string) => formatDateTime(iso)

const partyList = (v: string | null) => (v === null ? '' : v.split(', ').map(shortParty).join(', '))

/**
 * What the proposal changes if executed now: current value → new. Rows from
 * GET /governance, display only; what gets signed is a command on this card's contract.
 */
function ChangesDiff({ changes }: { changes: GovernanceChange[] }) {
  const rows = changeRows(changes)
  if (rows.length === 0)
    return (
      <p aria-label="Proposed changes" className="text-sm text-muted-foreground">
        Nothing changes compared with the current configuration.
      </p>
    )
  const show = (r: ChangeRow, v: string | null) =>
    v === null ? '—' : r.parties ? <FullValue value={v}>{partyList(v)}</FullValue> : v
  return (
    <ul aria-label="Proposed changes" className="divide-y rounded-lg bg-muted/60 px-3 text-sm">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-wrap items-baseline gap-x-2 py-2">
          <span className="min-w-40 text-muted-foreground">{r.label}</span>
          <span className="text-muted-foreground line-through">{show(r, r.from)}</span>
          <span aria-hidden="true" className="text-muted-foreground">
            →
          </span>
          <span className="font-medium">{show(r, r.to)}</span>
        </li>
      ))}
    </ul>
  )
}

interface ListProps {
  view: GovernanceView
  me: string | null
  now: Date
  busy: Busy | null
  disabled: boolean
  run: RunAction
}

const None = ({ text }: { text: string }) => (
  <Empty variant="outline" className="md:p-8">
    <EmptyHeader>
      <EmptyDescription>{text}</EmptyDescription>
    </EmptyHeader>
  </Empty>
)

/** Proposal card: id as the title, state as an icon on the right. */
function Item({
  label,
  title,
  state,
  children,
}: {
  label: string
  title: string
  state: ItemState
  children: ReactNode
}) {
  return (
    <Card asChild className="gap-3 p-4 shadow-none">
      <li aria-label={label}>
        {/* flex instead of the CardHeader grid: on a narrow screen the icon drops below a long id */}
        <CardHeader className="flex flex-wrap items-center gap-2 px-0">
          <CardTitle asChild>
            <h2 className="mr-auto text-base leading-snug break-all">{title}</h2>
          </CardTitle>
          <CardAction className="self-center">
            <StateBadge state={state} />
          </CardAction>
        </CardHeader>
        {children}
      </li>
    </Card>
  )
}

export function ProposalList({ view, me, now, busy, disabled, run }: ListProps) {
  if (view.proposals.length === 0)
    return <None text="No open proposals. A council member can propose a change below." />
  return (
    <ul aria-label="Proposals" className="flex flex-col gap-3">
      {view.proposals.map((p: GovernanceProposalView) => {
        const s = proposalState(p, view, now)
        return (
          <Item
            key={p.contractId}
            label={`Proposal ${p.proposalId}`}
            title={p.proposalId}
            state={s}
          >
            {p.description && <p className="text-sm text-foreground/80">{p.description}</p>}
            <Meta
              items={[
                ['Proposed by', <Party key="p" party={p.proposer} me={me} />],
                ['Expires', when(p.expiresAt)],
                ...(p.executableAfter
                  ? [['Executes from', when(p.executableAfter)] as [string, ReactNode]]
                  : []),
                [
                  'Contract',
                  <FullValue key="c" value={p.contractId} className="font-mono text-xs">
                    {p.contractId.slice(0, 12)}…
                  </FullValue>,
                ],
              ]}
            />
            <ChangesDiff changes={p.changes ?? []} />
            {p.trusted && (
              <p className="text-xs text-muted-foreground">
                Roles and transfer factories change only with the operator: after the threshold, the
                operator executes this proposal.
              </p>
            )}
            <Seats
              label="Approvals"
              members={view.council?.members ?? []}
              signed={p.approvals}
              threshold={s.threshold}
              me={me}
            />
            <Actions
              kind="proposals"
              contractId={p.contractId}
              actions={proposalActions(p, view, me, now)}
              busy={busy}
              disabled={disabled}
              run={run}
              what={`proposal ${p.proposalId}`}
            />
          </Item>
        )
      })}
    </ul>
  )
}

export function RotationList({ view, me, now, busy, disabled, run }: ListProps) {
  if (view.rotations.length === 0) return <None text="No council rotation in progress." />
  return (
    <ul aria-label="Council rotations" className="flex flex-col gap-3">
      {view.rotations.map((r: CouncilRotationView) => {
        const s = rotationState(r, view, now)
        const joining = r.newMembers.filter((m) => !r.members.includes(m))
        return (
          <Item
            key={r.contractId}
            label={`Rotation ${r.rotationId}`}
            title={r.rotationId}
            state={s}
          >
            <Meta
              items={[
                ['Proposed by', <Party key="p" party={r.proposer} me={me} />],
                ['Expires', when(r.expiresAt)],
                [
                  'New council',
                  `${r.newMembers.length} members, threshold ${r.newThreshold}${r.formation ? ' (first council)' : ''}`,
                ],
              ]}
            />
            <Seats
              label="Approvals of the current council"
              members={r.members}
              signed={r.approvals}
              threshold={s.threshold}
              me={me}
            />
            <Seats
              label="New members joined"
              members={joining}
              signed={r.joined}
              threshold={0}
              me={me}
            />
            {missingJoins(r).includes(me ?? '') && (
              <Alert variant="info">
                <AlertDescription>
                  You are a new member of this council. Join with your wallet: the rotation executes
                  only after every new member signs.
                </AlertDescription>
              </Alert>
            )}
            <Actions
              kind="rotations"
              contractId={r.contractId}
              actions={rotationActions(r, view, me, now)}
              busy={busy}
              disabled={disabled}
              run={run}
              what={`rotation ${r.rotationId}`}
            />
          </Item>
        )
      })}
    </ul>
  )
}

export function IncomeList({ view, me, now, busy, disabled, run }: ListProps) {
  if (view.income.length === 0) return <None text="No income proposals." />
  return (
    <ul aria-label="Income proposals" className="flex flex-col gap-3">
      {view.income.map((i: IncomeProposalView) => {
        const s = incomeState(i, view, now)
        return (
          <Item key={i.contractId} label={`Income ${i.proposalId}`} title={i.proposalId} state={s}>
            <ul aria-label="Amounts" className="flex flex-wrap gap-2">
              {[{ symbol: 'USDCx', amount: i.reservesAmount, what: 'reserves' }]
                .filter((x) => !isZero(x.amount))
                .map((x) => (
                  <Badge
                    key={x.symbol}
                    asChild
                    variant="secondary"
                    className="h-9 gap-2 rounded-lg pr-3 pl-1.5 text-sm font-normal"
                  >
                    <li>
                      <TokenIcon symbol={x.symbol} className="size-6" />
                      <FullValue value={x.amount} focusable={false} className="font-semibold">
                        {formatAmount(x.amount, 4)} {x.symbol}
                      </FullValue>
                      <span className="text-xs text-muted-foreground">{x.what}</span>
                    </li>
                  </Badge>
                ))}
            </ul>
            <Meta
              items={[
                ['Proposed by', <Party key="p" party={i.proposer} me={me} />],
                ['Expires', when(i.expiresAt)],
                ['Paid to', <Party key="t" party={i.treasury} me={me} />],
              ]}
            />
            <Seats
              label="Approvals"
              members={view.council?.members ?? []}
              signed={i.approvals}
              threshold={s.threshold}
              me={me}
            />
            <Actions
              kind="income"
              contractId={i.contractId}
              actions={incomeActions(i, view, me, now)}
              busy={busy}
              disabled={disabled}
              run={run}
              what={`income ${i.proposalId}`}
            />
          </Item>
        )
      })}
    </ul>
  )
}
