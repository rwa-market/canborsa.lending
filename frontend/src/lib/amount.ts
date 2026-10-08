/**
 * Amounts as strings: formatting and comparison without converting to number
 * (rule 8 in CLAUDE.md: the frontend does not compute money).
 */
const AMOUNT = /^\d+(\.\d{1,10})?$/

export const isAmount = (v: string) => AMOUNT.test(v)

function split(v: string): [string, string] {
  const [int = '0', frac = ''] = v.replace(/^-/, '').split('.')
  return [int.replace(/^0+(?=\d)/, ''), frac.replace(/0+$/, '')]
}

/** Compare two non-negative decimal strings: −1, 0, 1. */
export function compareAmounts(a: string, b: string): number {
  const [ai, af] = split(a)
  const [bi, bf] = split(b)
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1
  if (ai !== bi) return ai < bi ? -1 : 1
  const len = Math.max(af.length, bf.length)
  const x = af.padEnd(len, '0')
  const y = bf.padEnd(len, '0')
  return x === y ? 0 : x < y ? -1 : 1
}

export const isZero = (v: string) => /^0*(\.0*)?$/.test(v)

/** 12345.678901 → "12,345.67": truncate, do not round. */
export function formatAmount(v: string | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || v === '') return '—'
  const negative = v.startsWith('-')
  const [int, frac] = split(v)
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cut = frac.slice(0, decimals).padEnd(decimals, '0')
  return `${negative ? '−' : ''}${grouped}${decimals > 0 ? `.${cut}` : ''}`
}

/** 0.052 → "5.20%": shift the decimal point in the string. */
export function formatPercent(ratio: string | null | undefined, decimals = 2): string {
  if (ratio === null || ratio === undefined) return '—'
  // a borrower's net APR is negative: the sign stays (review 03.10, item 3)
  const sign = ratio.trim().startsWith('-') ? '−' : ''
  const [int, frac] = split(ratio)
  const f = frac.padEnd(2 + decimals, '0')
  const whole = (int + f.slice(0, 2)).replace(/^0+(?=\d)/, '')
  const digits = f.slice(2, 2 + decimals)
  const zero = /^0*$/.test(whole + digits)
  return `${zero ? '' : sign}${whole}${decimals > 0 ? `.${digits}` : ''}%`
}

/**
 * Wallet address in a button: start and end of the whole id, ellipsis in the middle, "8e5a…d5b4".
 * The end is the end of the full party id, so it matches the copied one (review 08.10, item 10).
 */
export const middleParty = (p: string, head = 4, tail = 4) =>
  p.length > head + tail + 1 ? `${p.slice(0, head)}…${p.slice(-tail)}` : p

export const shortParty = (p: string) => {
  const [hint = p, ns = ''] = p.split('::')
  return ns ? `${hint}::${ns.slice(0, 6)}…` : hint
}

/** HF for display: a ratio, not money. Truncate, do not round: 1.3996 is "1.39", not "1.40". */
export function formatHealth(hf: string | null | undefined): string {
  if (hf === null || hf === undefined) return 'no debt'
  return compareAmounts(hf, '100') > 0 ? '> 100' : formatAmount(hf, 2)
}

/** Signed balance (AccountSummary.balance): a minus is a debt. "-0.00" is not negative. */
export const isNegative = (v: string | null | undefined) =>
  !!v && v.trim().startsWith('-') && !isZero(v.trim().slice(1))

/** USD for display: "$1,200.00", "−$5.00", "—" without a price. */
export function formatUsd(v: string | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || v === '') return '—'
  return isNegative(v)
    ? `−$${formatAmount(v.trim().slice(1), decimals)}`
    : `$${formatAmount(v.replace(/^-/, ''), decimals)}`
}
