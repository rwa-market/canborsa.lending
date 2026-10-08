import type { GovernanceRolesView, GovernanceView, MarketId, PoolView } from '@lending/shared'
import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useId, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import {
  FieldDescription,
  FieldError as FieldErrorText,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Field as FieldRoot,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { compareAmounts, formatAmount, isNegative, isZero } from '@/lib/amount'
import { cn } from '@/lib/utils'
import type { Intent } from '@/wallet/verify'
import {
  defaultId,
  delayNote,
  EXPIRY_OPTIONS,
  expiresIn,
  isParty,
  MARKET_FIELDS,
  PARAM_VALUE,
  type ParamChange,
  partiesOf,
  patchesOf,
  PROTOCOL_FIELDS,
  suspiciousValue,
  sameRoles,
  type Scope,
} from './model'
import type { PreparedCommand } from '@lending/shared'

/** What the form hands over for signing: command assembly on the backend and the intent for the verifier. */
export interface Submission {
  build: () => Promise<PreparedCommand>
  intent: Intent
  done: string
}

interface FormProps {
  view: GovernanceView
  pool: PoolView | undefined
  party: string
  pending: boolean
  onSubmit: (s: Submission, reset: () => void) => void
}

const idField = z
  .string()
  .trim()
  .min(1, 'Enter an id')
  .max(100, 'Up to 100 characters')
  .regex(/^[\w.-]+$/, 'Letters, digits, dot, dash or underscore')

const TOKEN_AMOUNT = /^\d{1,12}(\.\d{1,10})?$/

type Errors = Record<string, string>

/** Error under the field: linked to the field via aria-describedby. */
function FieldError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null
  return <FieldErrorText id={id}>{text}</FieldErrorText>
}

function Field({
  id,
  label,
  error,
  hint,
  children,
  className,
}: {
  id: string
  label: string
  error?: string | undefined
  hint?: string | undefined
  children: React.ReactNode
  className?: string
}) {
  return (
    <FieldRoot className={cn('min-w-0 gap-1.5', className)} data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {hint && !error && (
        <FieldDescription id={`${id}-hint`} className="text-xs">
          {hint}
        </FieldDescription>
      )}
      <FieldError id={`${id}-error`} text={error} />
    </FieldRoot>
  )
}

const describedBy = (id: string, error?: string, hint?: boolean) =>
  error ? `${id}-error` : hint ? `${id}-hint` : undefined

function Expiry({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <Field id={id} label="Open for">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {EXPIRY_OPTIONS.map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

/** Current parameter value if /pool shows it: a hint under the field. */
function currentValue(pool: PoolView | undefined, scope: Scope, field: string): string | null {
  if (!pool) return null
  if (scope === 'protocol') {
    // rateModel.<field>: the pool's rate model (PoolView.rateModel)
    if (field.startsWith('rateModel.')) {
      const v = (pool.rateModel as unknown as Record<string, unknown>)[field.slice(10)]
      return typeof v === 'string' ? v : null
    }
    // limits.* and top-level PoolView fields (targetReserves, storeFrontPriceFactor)
    const v =
      (pool.limits as unknown as Record<string, unknown>)[field] ??
      (pool as unknown as Record<string, unknown>)[field]
    return typeof v === 'string' ? v : null
  }
  const m = pool.markets.find((x) => x.marketId === scope)
  const v = m ? (m as unknown as Record<string, unknown>)[field] : null
  return typeof v === 'string' ? v : null
}

const fieldsOf = (scope: Scope) => (scope === 'protocol' ? PROTOCOL_FIELDS : MARKET_FIELDS)

/** Council proposal: protocol and market parameters, roles. Does not change factories or the market set. */
export function ProposalForm({ view, pool, party, pending, onSubmit }: FormProps) {
  const uid = useId()
  const markets = (pool?.markets.map((m) => m.marketId) ?? ['CC', 'CBTC']) as MarketId[]
  const [proposalId, setProposalId] = useState(() => defaultId('params'))
  const [description, setDescription] = useState('')
  const [days, setDays] = useState('3')
  const [changes, setChanges] = useState<ParamChange[]>([
    { scope: 'protocol', field: 'minLoan', value: '' },
  ])
  const [rolesOn, setRolesOn] = useState(false)
  const [roles, setRoles] = useState(() => ({
    oracle: view.roles.oracle,
    guardian: view.roles.guardian,
    treasury: view.roles.treasury,
    backstop: view.roles.backstop,
    liquidators: view.roles.liquidators.join('\n'),
  }))
  const [errors, setErrors] = useState<Errors>({})

  const reset = () => {
    setProposalId(defaultId('params'))
    setDescription('')
    setChanges([{ scope: 'protocol', field: 'minLoan', value: '' }])
    setRolesOn(false)
    setErrors({})
  }

  const setChange = (i: number, patch: Partial<ParamChange>) =>
    setChanges((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const errs: Errors = {}
    const id = idField.safeParse(proposalId)
    if (!id.success) errs.id = id.error.issues[0]?.message ?? 'Invalid id'
    if (description.length > 1000) errs.description = 'Up to 1000 characters'
    changes.forEach((c, i) => {
      if (!PARAM_VALUE.test(c.value.trim())) errs[`change-${i}`] = 'Enter a decimal, like 0.75'
      else {
        const slip = suspiciousValue(c.field, c.value.trim())
        if (slip) errs[`change-${i}`] = slip
      }
    })
    let patches: ReturnType<typeof patchesOf> | null = null
    try {
      patches = patchesOf(changes.map((c) => ({ ...c, value: c.value.trim() })))
    } catch (err) {
      errs.changes = err instanceof Error ? err.message : String(err)
    }
    let newRoles: GovernanceRolesView | null = null
    if (rolesOn) {
      const liquidators = partiesOf(roles.liquidators)
      newRoles = {
        operator: view.roles.operator,
        oracle: roles.oracle.trim(),
        guardian: roles.guardian.trim(),
        treasury: roles.treasury.trim(),
        backstop: roles.backstop.trim(),
        liquidators,
      }
      for (const k of ['oracle', 'guardian', 'treasury', 'backstop'] as const)
        if (!isParty(newRoles[k])) errs[`role-${k}`] = 'Enter a party id: hint::fingerprint'
      if (liquidators.length < 1 || liquidators.length > 20)
        errs['role-liquidators'] = 'Between 1 and 20 liquidators'
      else if (!liquidators.every(isParty))
        errs['role-liquidators'] = 'Each line must be a party id: hint::fingerprint'
      else if (new Set(liquidators).size !== liquidators.length)
        errs['role-liquidators'] = 'Liquidators must differ'
      if (!errs['role-liquidators'] && sameRoles(newRoles, view.roles))
        errs.roles = 'The roles are the same as now: change one or turn this off'
    }
    if (changes.length === 0 && !rolesOn) errs.changes = 'Add a parameter change or change roles'
    setErrors(errs)
    if (Object.keys(errs).length > 0 || !patches || !id.success || !view.council) return
    const expiresAt = expiresIn(days)
    const { paramsPatch, marketParamsPatch } = patches
    const hasParams = Object.keys(paramsPatch).length > 0
    const hasMarkets = Object.keys(marketParamsPatch).length > 0
    onSubmit(
      {
        build: () =>
          api.proposeParams({
            party,
            proposalId: id.data,
            description,
            expiresAt,
            ...(newRoles ? { newRoles } : {}),
            ...(hasParams ? { paramsPatch } : {}),
            ...(hasMarkets ? { marketParamsPatch } : {}),
          }),
        intent: {
          kind: 'council-propose',
          councilCid: view.council.contractId,
          proposalId: id.data,
          description,
          expiresAt,
          paramsPatch,
          marketParamsPatch,
          newRoles,
        },
        done: 'Proposal created: you approved it as the proposer',
      },
      reset,
    )
  }

  return (
    <form aria-label="New proposal" onSubmit={submit} noValidate>
      <FieldGroup className="gap-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field id={`${uid}-id`} label="Proposal id" error={errors.id}>
            <Input
              id={`${uid}-id`}
              value={proposalId}
              autoComplete="off"
              aria-invalid={!!errors.id}
              aria-describedby={describedBy(`${uid}-id`, errors.id)}
              onChange={(e) => setProposalId(e.target.value)}
            />
          </Field>
          <Expiry id={`${uid}-days`} value={days} onChange={setDays} />
        </div>
        <Field id={`${uid}-desc`} label="Why" error={errors.description}>
          <Input
            id={`${uid}-desc`}
            value={description}
            placeholder="Lower the CC Collateral Factor after the volatility spike"
            aria-invalid={!!errors.description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-2">
            Parameter changes
          </FieldLegend>
          {changes.map((c, i) => {
            const fid = `${uid}-change-${i}`
            const err = errors[`change-${i}`]
            const now = currentValue(pool, c.scope, c.field)
            const delay = c.scope === 'protocol' ? null : delayNote(c.field)
            return (
              <div
                key={i}
                role="group"
                aria-label={`Change ${i + 1}`}
                className="grid items-start gap-2 rounded-lg border p-3 sm:grid-cols-[8rem_minmax(0,1fr)_9rem_auto]"
              >
                <Select
                  value={c.scope}
                  onValueChange={(v) =>
                    setChange(i, { scope: v as Scope, field: fieldsOf(v as Scope)[0][0] })
                  }
                >
                  <SelectTrigger className="w-full" aria-label={`Change ${i + 1}: scope`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="protocol">Protocol</SelectItem>
                      {markets.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m} market
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Select value={c.field} onValueChange={(v) => setChange(i, { field: v })}>
                  <SelectTrigger className="w-full" aria-label={`Change ${i + 1}: parameter`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {fieldsOf(c.scope).map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="flex flex-col gap-1">
                  <Input
                    id={fid}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="New value"
                    aria-label={`Change ${i + 1}: new value`}
                    aria-invalid={!!err}
                    aria-describedby={
                      [describedBy(fid, err, !!now), delay && `${fid}-delay`]
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    value={c.value}
                    onChange={(e) => setChange(i, { value: e.target.value })}
                  />
                  {now !== null && !err && (
                    <FieldDescription id={`${fid}-hint`} className="text-xs">
                      Now {now}
                    </FieldDescription>
                  )}
                  <FieldError id={`${fid}-error`} text={err} />
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove change ${i + 1}`}
                  onClick={() => setChanges((cs) => cs.filter((_, j) => j !== i))}
                >
                  <TrashIcon weight="bold" />
                </Button>
                {delay && (
                  <FieldDescription id={`${fid}-delay`} className="text-xs sm:col-span-4">
                    {delay}
                  </FieldDescription>
                )}
              </div>
            )
          })}
          <FieldError id={`${uid}-changes-error`} text={errors.changes} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              setChanges((cs) => [...cs, { scope: 'protocol', field: 'minLoan', value: '' }])
            }
          >
            <PlusIcon weight="bold" />
            Add a change
          </Button>
        </FieldSet>

        <FieldSet className="gap-3 rounded-lg border p-3">
          <FieldLegend className="sr-only">Roles</FieldLegend>
          <FieldRoot orientation="horizontal" className="gap-3">
            <Switch
              id={`${uid}-roles`}
              checked={rolesOn}
              onCheckedChange={setRolesOn}
              aria-describedby={`${uid}-roles-hint`}
            />
            <FieldLabel htmlFor={`${uid}-roles`}>Change roles</FieldLabel>
          </FieldRoot>
          <FieldDescription id={`${uid}-roles-hint`} className="text-xs">
            A new oracle or liquidator gets access to pool funds, so a role change needs the
            operator to execute it after the council approves. The operator itself cannot change.
          </FieldDescription>
          {rolesOn && (
            <div className="grid gap-4 sm:grid-cols-2">
              {(['oracle', 'guardian', 'treasury', 'backstop'] as const).map((k) => {
                const fid = `${uid}-role-${k}`
                const err = errors[`role-${k}`]
                return (
                  <Field
                    key={k}
                    id={fid}
                    label={k.charAt(0).toUpperCase() + k.slice(1)}
                    error={err}
                  >
                    <Input
                      id={fid}
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                      aria-invalid={!!err}
                      aria-describedby={describedBy(fid, err)}
                      value={roles[k]}
                      onChange={(e) => setRoles((r) => ({ ...r, [k]: e.target.value }))}
                    />
                  </Field>
                )
              })}
              <Field
                id={`${uid}-role-liquidators`}
                label="Liquidators, one per line"
                error={errors['role-liquidators']}
                className="sm:col-span-2"
              >
                <Textarea
                  id={`${uid}-role-liquidators`}
                  spellCheck={false}
                  className="min-h-24 font-mono"
                  aria-invalid={!!errors['role-liquidators']}
                  aria-describedby={describedBy(
                    `${uid}-role-liquidators`,
                    errors['role-liquidators'],
                  )}
                  value={roles.liquidators}
                  onChange={(e) => setRoles((r) => ({ ...r, liquidators: e.target.value }))}
                />
              </Field>
              <FieldError id={`${uid}-roles-error`} text={errors.roles} />
            </div>
          )}
        </FieldSet>

        <Button type="submit" className="self-start" disabled={pending || !view.council}>
          Propose
        </Button>
      </FieldGroup>
    </form>
  )
}

/** Council rotation: new membership and threshold. New members join with their own signature. */
export function RotationForm({ view, party, pending, onSubmit }: FormProps) {
  const uid = useId()
  const [rotationId, setRotationId] = useState(() => defaultId('council'))
  const [members, setMembers] = useState(() => (view.council?.members ?? []).join('\n'))
  const [threshold, setThreshold] = useState(() => String(view.council?.threshold ?? 1))
  const [days, setDays] = useState('3')
  const [errors, setErrors] = useState<Errors>({})

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const errs: Errors = {}
    const id = idField.safeParse(rotationId)
    if (!id.success) errs.id = id.error.issues[0]?.message ?? 'Invalid id'
    const list = partiesOf(members)
    if (list.length < 1 || list.length > 20) errs.members = 'Between 1 and 20 members'
    else if (!list.every(isParty)) errs.members = 'Each line must be a party id: hint::fingerprint'
    else if (new Set(list).size !== list.length) errs.members = 'Members must differ'
    else if (list.includes(view.roles.operator))
      errs.members = 'The operator cannot be a council member'
    const k = z.coerce.number().int().min(1).safeParse(threshold)
    if (!k.success || k.data > Math.max(list.length, 1))
      errs.threshold = `Between 1 and ${Math.max(list.length, 1)}`
    setErrors(errs)
    if (Object.keys(errs).length > 0 || !id.success || !k.success || !view.council) return
    const expiresAt = expiresIn(days)
    onSubmit(
      {
        build: () =>
          api.proposeRotation({
            party,
            rotationId: id.data,
            newMembers: list,
            newThreshold: k.data,
            expiresAt,
          }),
        intent: {
          kind: 'rotation-propose',
          councilCid: view.council.contractId,
          rotationId: id.data,
          newMembers: list,
          newThreshold: k.data,
          expiresAt,
        },
        done: 'Council rotation proposed',
      },
      () => {
        setRotationId(defaultId('council'))
        setErrors({})
      },
    )
  }

  return (
    <form aria-label="New council rotation" onSubmit={submit} noValidate>
      <FieldGroup className="gap-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field id={`${uid}-id`} label="Rotation id" error={errors.id}>
            <Input
              id={`${uid}-id`}
              value={rotationId}
              autoComplete="off"
              aria-invalid={!!errors.id}
              aria-describedby={describedBy(`${uid}-id`, errors.id)}
              onChange={(e) => setRotationId(e.target.value)}
            />
          </Field>
          <Expiry id={`${uid}-days`} value={days} onChange={setDays} />
        </div>
        <Field
          id={`${uid}-members`}
          label="New council, one party per line"
          error={errors.members}
          hint="Members who are not on the council now must join with their own wallet before the rotation executes."
        >
          <Textarea
            id={`${uid}-members`}
            spellCheck={false}
            className="min-h-24 font-mono"
            aria-invalid={!!errors.members}
            aria-describedby={describedBy(`${uid}-members`, errors.members, true)}
            value={members}
            onChange={(e) => setMembers(e.target.value)}
          />
        </Field>
        <Field
          id={`${uid}-threshold`}
          label="Approvals needed"
          error={errors.threshold}
          className="max-w-40"
        >
          <Input
            id={`${uid}-threshold`}
            inputMode="numeric"
            aria-invalid={!!errors.threshold}
            aria-describedby={describedBy(`${uid}-threshold`, errors.threshold)}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value.trim())}
          />
        </Field>
        <Button type="submit" className="self-start" disabled={pending || !view.council}>
          Propose rotation
        </Button>
      </FieldGroup>
    </form>
  )
}

/** Protocol revenue: USDCx reserves go to treasury, only from non-negative reserves (K6). */
export function IncomeForm({
  view,
  pool,
  party,
  pending,
  onSubmit,
  treasury,
}: FormProps & {
  /** Treasury from /config: must match the role in /governance */
  treasury: string | undefined
}) {
  const uid = useId()
  const [proposalId, setProposalId] = useState(() => defaultId('income'))
  const [reserves, setReserves] = useState('')
  const [days, setDays] = useState('3')
  const [errors, setErrors] = useState<Errors>({})

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const errs: Errors = {}
    const id = idField.safeParse(proposalId)
    if (!id.success) errs.id = id.error.issues[0]?.message ?? 'Invalid id'
    const r = reserves.trim()
    if (!TOKEN_AMOUNT.test(r)) errs.reserves = 'Enter an amount with up to 10 decimals'
    else if (isZero(r)) errs.reserves = 'Enter the reserves to pay out'
    else if (pool && isNegative(pool.reserves))
      errs.reserves = 'Reserves are negative: nothing can be paid out'
    else if (pool && compareAmounts(r, pool.reserves) > 0)
      errs.reserves = `More than the protocol reserves (${formatAmount(pool.reserves, 4)})`
    if (!treasury || treasury !== view.roles.treasury)
      errs.reserves = 'The treasury role is unclear: reload the page and try again'
    setErrors(errs)
    if (Object.keys(errs).length > 0 || !id.success || !view.council || !treasury) return
    const expiresAt = expiresIn(days)
    onSubmit(
      {
        build: () =>
          api.proposeIncome({
            party,
            proposalId: id.data,
            reservesAmount: r,
            expiresAt,
          }),
        intent: {
          kind: 'income-propose',
          councilCid: view.council.contractId,
          proposalId: id.data,
          treasury,
          reservesAmount: r,
        },
        done: 'Income proposal created',
      },
      () => {
        setProposalId(defaultId('income'))
        setReserves('')
        setErrors({})
      },
    )
  }

  return (
    <form aria-label="New income proposal" onSubmit={submit} noValidate>
      <FieldGroup className="gap-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field id={`${uid}-id`} label="Proposal id" error={errors.id}>
            <Input
              id={`${uid}-id`}
              value={proposalId}
              autoComplete="off"
              aria-invalid={!!errors.id}
              aria-describedby={describedBy(`${uid}-id`, errors.id)}
              onChange={(e) => setProposalId(e.target.value)}
            />
          </Field>
          <Expiry id={`${uid}-days`} value={days} onChange={setDays} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id={`${uid}-reserves`}
            label="Reserves, USDCx"
            error={errors.reserves}
            hint={pool ? `Protocol reserves ${formatAmount(pool.reserves, 4)}` : undefined}
          >
            <Input
              id={`${uid}-reserves`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              aria-invalid={!!errors.reserves}
              aria-describedby={describedBy(`${uid}-reserves`, errors.reserves, !!pool)}
              value={reserves}
              onChange={(e) => setReserves(e.target.value)}
            />
          </Field>
        </div>
        <FieldDescription className="text-xs">
          Paid only to the treasury in the protocol config. After the threshold, the treasury signs
          the payout with its own wallet.
        </FieldDescription>
        <Button type="submit" className="self-start" disabled={pending || !view.council}>
          Propose payout
        </Button>
      </FieldGroup>
    </form>
  )
}
