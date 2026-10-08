/**
 * Protocol tokens: name, display decimals and market order. Markets come from /config; labels and
 * precision come from here.
 */
import type { MarketId, TokenSymbol } from '@lending/shared'

export const TOKEN_NAMES: Record<TokenSymbol, string> = {
  USDCx: 'USDC on Canton',
  CC: 'Canton Coin',
  CBTC: 'Canton Bitcoin',
}

/** Decimal places in balances and positions. */
export const TOKEN_DIGITS: Record<TokenSymbol, number> = {
  USDCx: 2,
  CC: 2,
  CBTC: 6,
}

/** Decimal places in market totals (all collateral of a market). */
export const TOTAL_DIGITS: Record<TokenSymbol, number> = {
  USDCx: 0,
  CC: 0,
  CBTC: 4,
}

/** Market display order. */
export const MARKET_ORDER: MarketId[] = ['CC', 'CBTC']

/** Markets of /config in display order; without config, CC and CBTC. */
export function marketsOf(config: { markets?: MarketId[] } | undefined): MarketId[] {
  const listed = config?.markets ?? MARKET_ORDER
  return MARKET_ORDER.filter((m) => listed.includes(m))
}

export const tokenName = (s: string) => TOKEN_NAMES[s as TokenSymbol] ?? s
export const tokenDigits = (s: string) => TOKEN_DIGITS[s as TokenSymbol] ?? 4
export const totalDigits = (s: string) => TOTAL_DIGITS[s as TokenSymbol] ?? 2
