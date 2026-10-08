/**
 * Transfer inputs from wallet holdings (audit F-16): largest first until they cover the
 * amount, and no more than MAX_INPUTS. Previously all user holdings went into the command.
 */
import { cmp, sum, toUnits } from '../lib/decimal.ts'

export interface Holding {
  cid: string
  amount: string
}

/** Backend limit on inputHoldingCids (routes/protocol.ts: max 50). */
export const MAX_INPUTS = 50

export function pickInputs(holdings: readonly Holding[], target: string | null): string[] {
  const sorted = [...holdings].sort((a, b) => cmp(b.amount, a.amount))
  if (target === null) return sorted.slice(0, MAX_INPUTS).map((h) => h.cid)
  const want = toUnits(target)
  const picked: string[] = []
  let covered = 0n
  for (const h of sorted) {
    if (covered >= want || picked.length >= MAX_INPUTS) break
    picked.push(h.cid)
    covered += toUnits(h.amount)
  }
  return picked
}

/** Free balance: sum of holdings, for display and the Max button (F-10). */
export const totalOf = (holdings: readonly Holding[]) => sum(holdings.map((h) => h.amount))
