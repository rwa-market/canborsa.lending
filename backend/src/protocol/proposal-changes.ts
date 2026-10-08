/**
 * What a council proposal would change if executed now (GET /governance). Proposal_Execute replaces
 * parameters and markets wholesale, so the comparison is against the current config, not the one at
 * proposal time. The result is for display to the approver only: what the signature authorizes is
 * the command the wallet verifier checks, not this list.
 */
import type { GovernanceChange } from '@lending/shared'
import { dec } from './math.ts'
import type { ConfigPayload, ParameterChangeProposalPayload } from './types.ts'

const DECIMAL = /^-?\d+(\.\d+)?$/

/** Decimals are compared by value: "0.0200000000" and "0.02" are the same. */
function same(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  if (DECIMAL.test(a) && DECIMAL.test(b)) return dec(a).eq(b)
  return a === b
}

function leaf(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (Array.isArray(v)) return v.map((x) => leaf(x) ?? '').join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Daml records flattened: `rateModel.slope1` → value as a string; lists comma-separated. */
function flatten(v: unknown, prefix = '', out = new Map<string, string | null>()) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out)
  } else out.set(prefix, leaf(v))
  return out
}

function diff(
  scope: GovernanceChange['scope'],
  target: string | null,
  from: unknown,
  to: unknown,
): GovernanceChange[] {
  const a = flatten(from)
  const b = flatten(to)
  const out: GovernanceChange[] = []
  for (const field of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(field) ?? null
    const y = b.get(field) ?? null
    if (!same(x, y)) out.push({ scope, target, field, from: x, to: y })
  }
  return out
}

/** Daml Map in the JSON Ledger API: `[[k, v], …]`; `{_1, _2}` is accepted too. */
function entries(m: unknown): [unknown, unknown][] {
  if (!Array.isArray(m)) return []
  return m.flatMap((e): [unknown, unknown][] => {
    if (Array.isArray(e) && e.length === 2) return [[e[0], e[1]]]
    if (e && typeof e === 'object' && '_1' in e && '_2' in e)
      return [[(e as { _1: unknown })._1, (e as { _2: unknown })._2]]
    return []
  })
}

const instrumentKey = (i: unknown) =>
  i && typeof i === 'object' && 'admin' in i && 'id' in i
    ? `${String((i as { admin: unknown }).admin)}::${String((i as { id: unknown }).id)}`
    : String(i)

function keyed(
  scope: 'market' | 'factories',
  now: unknown,
  next: unknown,
  key: (k: unknown) => string,
): GovernanceChange[] {
  const a = new Map(entries(now).map(([k, v]) => [key(k), v]))
  const b = new Map(entries(next).map(([k, v]) => [key(k), v]))
  const out: GovernanceChange[] = []
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k)
    const y = b.get(k)
    if (x === undefined) out.push({ scope, target: k, field: '', from: null, to: leaf(y) })
    else if (y === undefined) out.push({ scope, target: k, field: '', from: leaf(x), to: null })
    else out.push(...diff(scope, k, x, y))
  }
  return out
}

export function proposalChanges(
  p: ParameterChangeProposalPayload,
  config: ConfigPayload,
): GovernanceChange[] {
  const out = [
    ...diff('protocol', null, config.params, p.newParams),
    ...keyed('market', config.marketParams, p.newMarketParams, String),
  ]
  if (p.newRoles) out.push(...diff('roles', null, config.roles, p.newRoles))
  if (p.newTransferFactories)
    out.push(...keyed('factories', config.transferFactories, p.newTransferFactories, instrumentKey))
  const change = p.featuredAppRightChange as { tag?: string; value?: unknown } | null | undefined
  const current = config.featuredAppRight ?? null
  if (change?.tag === 'FeaturedRight_Set') {
    const to = leaf(change.value)
    if (!same(current, to))
      out.push({ scope: 'featuredAppRight', target: null, field: '', from: current, to })
  } else if (change?.tag === 'FeaturedRight_Clear' && current !== null)
    out.push({ scope: 'featuredAppRight', target: null, field: '', from: current, to: null })
  return out
}
