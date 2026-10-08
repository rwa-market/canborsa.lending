/**
 * Contract rejections (lending-core-v2) that depend on protocol state. The node wallet returns
 * the ledger rejection text as is, the backend a code and an explanation (backend/src/protocol/errors.ts):
 * here both cases become one clear message. Module without alias imports: vitest
 * runs it.
 */

const RULES: { test: RegExp; code: string; message: string }[] = [
  {
    test: /reserves are negative|withdrawals wait for recapitalization|WITHDRAWALS_WAIT_FOR_RECAPITALIZATION/,
    code: 'WITHDRAWALS_WAIT_FOR_RECAPITALIZATION',
    message:
      'Withdrawals and new loans are closed: protocol reserves are negative after bad debt. They reopen once the treasury adds reserves; supply, repayments and collateral deposits stay open.',
  },
  {
    test: /withdrawal exceeds the deposit: borrow explicitly|WITHDRAW_EXCEEDS_DEPOSIT/,
    code: 'WITHDRAW_EXCEEDS_DEPOSIT',
    message:
      'This is more than your USDCx supply. A withdrawal never borrows: use Borrow if you want a loan.',
  },
  {
    test: /debt asset depegged|USDCX_DEPEG/,
    code: 'USDCX_DEPEG',
    message: 'New loans are paused: the USDCx price is too far from $1.',
  },
  {
    test: /reserve coverage below required level|RESERVE_COVERAGE_LOW/,
    code: 'RESERVE_COVERAGE_LOW',
    message:
      'CBTC reserves are not attested right now, so CBTC adds nothing to your borrow capacity.',
  },
  {
    test: /borrowing paused|deposit withdrawals paused|collateral withdrawal paused|collateral purchase paused|absorb paused|OPERATION_PAUSED/,
    code: 'OPERATION_PAUSED',
    message:
      'The guardian has paused this action. Supply, repayments and collateral deposits are never paused.',
  },
  {
    test: /debt exceeds the repay bound|REPAY_BOUND_EXCEEDED/,
    code: 'REPAY_BOUND_EXCEEDED',
    message: 'The debt grew past the amount you signed. Prepare the repayment again.',
  },
  {
    test: /price feed: wrong oracle|reserve attestation: wrong oracle|PRICE_FEED_WRONG_ORACLE/,
    code: 'PRICE_FEED_WRONG_ORACLE',
    message:
      'The price oracle was rotated and the new oracle has not published prices yet. Try again in a few minutes.',
  },
  {
    test: /price feed: (stale price|quote from the future|sources deviate|at least two distinct sources)|PRICE_UNAVAILABLE/,
    code: 'PRICE_UNAVAILABLE',
    message:
      'Prices are not valid right now (stale or the sources disagree). Try again after the next price update.',
  },
  {
    // Review 08.10, item 8: the signing window ran out before the approval reached the protocol
    test: /LOOP_SIGNATURE_EXPIRED|EVM signature expired|signature expired/i,
    code: 'LOOP_SIGNATURE_EXPIRED',
    message:
      'The signature expired: it is valid for 30 minutes and arrived later. Nothing was sent; start the operation again.',
  },
  {
    test: /login lifetime exceeds maxLoginTtl|LOGIN_TTL_EXCEEDED/,
    code: 'LOGIN_TTL_EXCEEDED',
    message: 'This sign-in request lives too long. Start the sign-in again.',
  },
]

/** Explanation of a known rejection by backend code or ledger text; otherwise null. */
export function explainError(message: string, code?: string | null): string | null {
  const byCode = code ? RULES.find((r) => r.code === code) : undefined
  if (byCode) return byCode.message
  return RULES.find((r) => r.test.test(message))?.message ?? null
}
