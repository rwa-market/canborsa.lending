import { compareAmounts } from '@/lib/amount'

/**
 * Liquidation risk colour: green is safe, orange from the warning level
 * (pool.limits.liquidationRiskWarning), red from 100 %: the account can be absorbed.
 * Compared as strings: the risk comes from the backend.
 */
export function riskTone(
  risk: string | null | undefined,
  warning = '0.71',
  /** a debt whose risk is unknown (no usable price) is not shown as safe */
  hasDebt = false,
): string {
  if (risk === null || risk === undefined) return hasDebt ? 'text-muted-foreground' : 'text-success'
  if (compareAmounts(risk, '1') >= 0) return 'text-destructive'
  if (compareAmounts(risk, warning) >= 0) return 'text-warning-foreground'
  return 'text-success'
}
