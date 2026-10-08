/**
 * One commandId per user intent (audit F-6).
 *
 * All attempts of one intent use one commandId: if the first one did execute after all,
 * the ledger drops the second as a duplicate. After an ambiguous failure (wallet timeout, drop)
 * the id is kept for DEDUP_MS: pressing again with the same amount and market reuses
 * it, so there is no double supply or borrow. After success or an unambiguous refusal
 * the id is forgotten; the next identical action is a new intent.
 */
const DEDUP_MS = 10 * 60_000

const pending = new Map<string, { id: string; until: number }>()

const newId = () =>
  `lending-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`

/** Intent key: everything the user chose. The party is included so sessions do not mix. */
export const intentKey = (party: string, op: string, fields: Record<string, unknown>) =>
  JSON.stringify([party, op, fields])

export function commandIdFor(key: string, now = Date.now()): string {
  const p = pending.get(key)
  if (p && p.until > now) return p.id
  pending.delete(key)
  return newId()
}

/** Intent outcome: ambiguous keeps the id for a retry; otherwise forget it. */
export function settle(key: string, id: string, ambiguous: boolean, now = Date.now()) {
  if (ambiguous) pending.set(key, { id, until: now + DEDUP_MS })
  else pending.delete(key)
}
