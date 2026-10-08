/**
 * EVM wallet signature message (0.5.0, ADR-004). The contract builds the same text
 * (daml/lending-core-v2/daml/Lending/Evm.daml: evmMessage, actionLine) and verifies the signature
 * against it. The backend returns the text with the command; the frontend builds it itself from the
 * user's intent and signs only if the texts match. A shared vector is kept by the tests
 * on both sides (EvmTest.daml, backend/test/evm.test.ts).
 */

/**
 * Operation the user signs (K2). Amounts are token decimal strings. Withdraw and Borrow are
 * different texts (risk 7): a withdrawal never turns into a loan unsigned.
 * supply with full: repay the whole debt, `amount` is the cap.
 */
export type EvmAction =
  | { kind: 'supply'; amount: string; full: boolean }
  | { kind: 'withdraw'; amount: string; full: boolean }
  | { kind: 'borrow'; amount: string }
  | { kind: 'deposit-collateral'; marketId: string; amount: string }
  | { kind: 'withdraw-collateral'; marketId: string; amount: string }

/**
 * Real-asset wallet operations (lending-core 0.6.0, Pool_EvmWalletExecute): withdrawal of
 * free balance to a Canton party and of USDCx to Ethereum. `symbol` is the instrument id
 * (InstrumentId.id: USDCx, Amulet, CBTC) as the contract prints it; the redeem line takes the
 * debt instrument id (`debt`), as Lending.Evm.actionLine does.
 */
export type EvmWalletAction =
  | { kind: 'transfer-out'; symbol: string; amount: string; receiver: string }
  | { kind: 'redeem'; amount: string; ethAddress: string; requestId: string }

/** Wallet operation message fields: same as for pool operations, different action. */
export type EvmWalletMessageFields = Omit<EvmMessageFields, 'action'> & {
  action: EvmWalletAction
}

export interface EvmMessageFields {
  /** Canton network from EvmWallet.network, e.g. canton:devnet */
  network: string
  /** Protocol operator party */
  operator: string
  /** Wallet address: 0x and 40 lowercase hex */
  address: string
  action: EvmAction
  /** debt instrument id, USDCx */
  debt: string
  nonce: number
  /** Signature expiry, ISO time to the second */
  expiresAt: string
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/

export const isEvmAddress = (v: string) => EVM_ADDRESS.test(v)

/** Address in contract form: lowercase. null if not an address. */
export function normalizeEvmAddress(v: string): string | null {
  const a = v.trim().toLowerCase()
  return isEvmAddress(a) ? a : null
}

/**
 * Decimal as Daml `show` prints it: no trailing zeros, at least one digit after the
 * point ("100.0", "0.05"). A token never has more than 10 places; more is a caller error.
 */
export function damlDecimal(v: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(v.trim())
  if (!m) throw new Error(`not a decimal amount: ${v}`)
  const int = m[1]!.replace(/^0+(?=\d)/, '')
  const frac = (m[2] ?? '').replace(/0+$/, '')
  if (frac.length > 10) throw new Error(`more than 10 decimals: ${v}`)
  return `${int}.${frac || '0'}`
}

/** Time as Daml `show` prints it for whole seconds: 2026-10-01T12:00:00Z. */
export function damlTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) throw new Error(`not a time: ${iso}`)
  if (t % 1000 !== 0) throw new Error(`signature expiry must be whole seconds: ${iso}`)
  return new Date(t).toISOString().replace('.000Z', 'Z')
}

/** Action line, as Lending.Evm.actionLine. */
export function evmActionLine(debt: string, a: EvmAction | EvmWalletAction): string {
  switch (a.kind) {
    case 'transfer-out':
      return `Send ${damlDecimal(a.amount)} ${a.symbol} to ${a.receiver}`
    case 'redeem':
      return `Redeem ${damlDecimal(a.amount)} ${debt} to Ethereum ${a.ethAddress}`
    case 'supply':
      return a.full
        ? `Repay all ${debt} debt, up to ${damlDecimal(a.amount)}`
        : `Supply ${damlDecimal(a.amount)} ${debt}`
    case 'withdraw':
      return a.full ? `Withdraw all ${debt}` : `Withdraw ${damlDecimal(a.amount)} ${debt}`
    case 'borrow':
      return `Borrow ${damlDecimal(a.amount)} ${debt}`
    case 'deposit-collateral':
      return `Deposit ${damlDecimal(a.amount)} ${a.marketId} as collateral`
    case 'withdraw-collateral':
      return `Withdraw ${damlDecimal(a.amount)} ${a.marketId} collateral`
  }
}

/** Text for personal_sign, as Lending.Evm.evmMessage. */
export function evmMessage(f: EvmMessageFields | EvmWalletMessageFields): string {
  if (!isEvmAddress(f.address)) throw new Error(`not a lowercase EVM address: ${f.address}`)
  if (!Number.isInteger(f.nonce) || f.nonce < 0) throw new Error(`bad nonce: ${f.nonce}`)
  return [
    'Canton Lending',
    evmActionLine(f.debt, f.action),
    `Account: ${f.address}`,
    `Network: ${f.network}`,
    `Operator: ${f.operator}`,
    `Nonce: ${f.nonce}`,
    `Expires: ${damlTime(f.expiresAt)}`,
  ].join('\n')
}

/** API sign-in message (off-ledger, like Sign-In with Ethereum): nonce from the backend. */
export function evmLoginMessage(f: {
  host: string
  address: string
  network: string
  nonce: string
  issuedAt: string
  expiresAt: string
}): string {
  return [
    `${f.host} wants you to sign in to Canton Lending with your wallet:`,
    f.address,
    '',
    'Signing is free and does not send a transaction.',
    '',
    `Network: ${f.network}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expiresAt}`,
  ].join('\n')
}
