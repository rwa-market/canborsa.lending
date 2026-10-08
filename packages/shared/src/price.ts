/**
 * Price problems in words, one text for the backend preview and the dashboard (review 08.10,
 * item 1): the reason and the age of the oldest quote, the one the contract checks.
 */
import type { PriceView } from './api.ts'

/** Age in seconds as people say it: «45 s», «6 min», «2 h». */
export const formatAge = (seconds: number) =>
  seconds < 120
    ? `${Math.max(0, Math.round(seconds))} s`
    : seconds < 7200
      ? `${Math.floor(seconds / 60)} min`
      : `${Math.floor(seconds / 3600)} h`

/** Why a price is not usable: "stale price, oldest quote 6 min old"; null when the view is valid. */
export function priceIssue(pv: PriceView | null | undefined): string | null {
  if (!pv) return 'no price published yet'
  if (pv.valid) return null
  return `${pv.reason ?? 'not usable'}, oldest quote ${formatAge(pv.ageSeconds)} old`
}
