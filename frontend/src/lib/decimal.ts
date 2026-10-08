/**
 * Exact decimal strings on BigInt, without number (rule 8 in CLAUDE.md).
 * Money is still computed by the contract and the backend. This is only for checking the command before
 * signing (amount in the command versus the entered one), summing holdings to show the balance
 * and selecting transfer inputs.
 */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/
/** Numeric 18 in Daml: the ledger never has more decimal places. */
const SCALE = 18
const ONE = 10n ** BigInt(SCALE)

export const isDecimal = (v: unknown): v is string =>
  typeof v === 'string' && DECIMAL.test(v) && (v.split('.')[1]?.length ?? 0) <= SCALE

/** "12.5" → 12.5·10^18. Throws on negatives, exponents and extra decimal places. */
export function toUnits(v: string): bigint {
  const m = DECIMAL.exec(v)
  if (!m) throw new Error(`not a decimal: ${v}`)
  const frac = m[2] ?? ''
  if (frac.length > SCALE) throw new Error(`more than ${SCALE} decimals: ${v}`)
  return BigInt(m[1]!) * ONE + BigInt(frac.padEnd(SCALE, '0') || '0')
}

/** 12.5·10^18 → "12.5": without trailing zeros. */
export function fromUnits(u: bigint): string {
  if (u < 0n) throw new Error('negative amount')
  const int = u / ONE
  const frac = (u % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '')
  return frac ? `${int}.${frac}` : int.toString()
}

export const cmp = (a: string, b: string): -1 | 0 | 1 => {
  const x = toUnits(a)
  const y = toUnits(b)
  return x === y ? 0 : x < y ? -1 : 1
}

export const add = (a: string, b: string) => fromUnits(toUnits(a) + toUnits(b))

export const sum = (xs: readonly string[]) => fromUnits(xs.reduce((s, x) => s + toUnits(x), 0n))

/** a − b; a negative result is an error. */
export const sub = (a: string, b: string) => fromUnits(toUnits(a) - toUnits(b))

/** a · num / den, rounded down. For check bounds, e.g. "debt + 1 %". */
export const mulRatio = (a: string, num: bigint, den: bigint) => fromUnits((toUnits(a) * num) / den)

/** Round up to `decimals` places, like toFixed(n, ROUND_UP) on the backend. */
export function ceilTo(a: string, decimals: number): string {
  const step = 10n ** BigInt(SCALE - decimals)
  const u = toUnits(a)
  return fromUnits(((u + step - 1n) / step) * step)
}

/** Truncate down to `decimals` places: the balance for the amount field must not exceed the actual one. */
export const floorTo = (a: string, decimals: number) => {
  const step = 10n ** BigInt(SCALE - decimals)
  return fromUnits((toUnits(a) / step) * step)
}
