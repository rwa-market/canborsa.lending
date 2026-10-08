/**
 * Contract rejections that depend on protocol state rather than on a request error.
 * The backend answers them with a clear 4xx and a code; the frontend shows an explanation.
 * Abort texts are from lending-core-v2 (Pool.daml, Oracle.daml, Auth.daml).
 */

export type RejectionCode =
  | 'WITHDRAWALS_WAIT_FOR_RECAPITALIZATION'
  | 'COLLATERAL_SALE_CLOSED'
  | 'PURCHASE_ABOVE_STOCK'
  | 'PURCHASE_TOO_SMALL'
  | 'PRICE_FEED_WRONG_ORACLE'
  | 'PRICE_UNAVAILABLE'
  | 'LOGIN_EXPIRED'
  | 'LOGIN_TTL_EXCEEDED'
  | 'REPAY_BOUND_EXCEEDED'
  | 'REGISTRY_FEE'

export interface Rejection {
  code: RejectionCode
  status: number
  message: string
}

const RULES: { test: RegExp; code: RejectionCode; status: number; message: string }[] = [
  {
    // "reserves are negative: withdrawals and loans wait for recapitalization" (K6)
    test: /wait for recapitalization/i,
    code: 'WITHDRAWALS_WAIT_FOR_RECAPITALIZATION',
    status: 409,
    message:
      'Withdrawals and new loans are closed: protocol reserves are negative after bad debt. They reopen once the treasury adds reserves; supply, collateral deposits and repayments stay open.',
  },
  {
    test: /collateral not for sale: reserves at target/i,
    code: 'COLLATERAL_SALE_CLOSED',
    status: 409,
    message: 'Collateral sales are closed: protocol reserves have reached the target.',
  },
  {
    test: /pays more than the whole stock costs/i,
    code: 'PURCHASE_ABOVE_STOCK',
    status: 409,
    message:
      'The payment is above what everything for sale costs now: the price moved. Get a new quote and pay that.',
  },
  {
    test: /purchase is at least 1 USDCx/i,
    code: 'PURCHASE_TOO_SMALL',
    status: 400,
    message: 'A purchase is at least 1 USDCx, unless it buys everything for sale.',
  },
  {
    test: /price feed: wrong oracle|reserve attestation: wrong oracle/i,
    code: 'PRICE_FEED_WRONG_ORACLE',
    status: 409,
    message:
      'The price oracle was rotated and the new oracle has not published prices yet. Try again in a few minutes.',
  },
  {
    test: /price feed: (stale price|quote from the future|sources deviate|at least two distinct sources)/i,
    code: 'PRICE_UNAVAILABLE',
    status: 409,
    message:
      'Prices are not valid right now (stale or the sources disagree). Try again after the next price update.',
  },
  {
    test: /login lifetime exceeds maxLoginTtl/i,
    code: 'LOGIN_TTL_EXCEEDED',
    status: 401,
    message: 'This sign-in request lives too long. Start the sign-in again.',
  },
  {
    test: /login expired/i,
    code: 'LOGIN_EXPIRED',
    status: 401,
    message: 'The sign-in request expired. Start the sign-in again.',
  },
  {
    // 0.4.1, F-11: repay all = Some True, but the debt at transaction time exceeded the signed cap
    test: /debt exceeds the repay bound/i,
    code: 'REPAY_BOUND_EXCEEDED',
    status: 409,
    message: 'The debt grew past the amount you signed. Prepare the repayment again.',
  },
  {
    // 0.6.0, EvmTransferOut withdrawal: the registry took more than the transfer amount from the
    // custodian (fee). The contract requires spending exactly amount, otherwise wallets diverge
    // from holdings.
    test: /transfer: sender spent a different amount than the transfer/i,
    code: 'REGISTRY_FEE',
    status: 409,
    message:
      'The token registry charges a fee on this transfer, so the withdrawal is refused. Nothing was debited and your signature was not used. Withdrawals of this token reopen once the registry stops charging fees.',
  },
]

/** Known rejection by the ledger error text, or null. */
export function explainRejection(text: string): Rejection | null {
  const r = RULES.find((x) => x.test.test(text))
  return r ? { code: r.code, status: r.status, message: r.message } : null
}

/**
 * A rejection the backend sees before the contract (the same check as in Daml): same code and
 * status as the ledger rejection, so the client handles them the same way.
 */
export class ProtocolStateError extends Error {
  readonly code: RejectionCode
  readonly status: number
  /** `message`: a more specific text of the same rejection (e.g. with the market name). */
  constructor(code: RejectionCode, message?: string) {
    const r = RULES.find((x) => x.code === code)!
    super(message ?? r.message)
    this.code = code
    this.status = r.status
  }
}
