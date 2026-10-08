/**
 * Loop wallet (lending-core-v2). Loop does not run third-party DARs, so a Loop user's
 * account is custodial, like the EVM wallet: LoopWallet under the custodian.
 * The user signs the operation text with their party's Ed25519 key
 * (`provider.signMessage`); the backend verifies the signature: Daml has no Ed25519 check. Contract
 * checks the nonce and expiry and stores the signed text for audit.
 *
 * The Loop session subject is `loop:<party>`, so it is not mixed up with the session of a Canton
 * party that signed in with its own wallet via Login.
 */
import { damlTime, type EvmAction, evmActionLine } from './evm.ts'

export const LOOP_PREFIX = 'loop:'

/** Canton party: `<hint>::<fingerprint>`. */
const PARTY = /^[\w.-]{1,185}::[0-9a-f]{8,128}$/

export const isLoopSubject = (v: string) =>
  v.startsWith(LOOP_PREFIX) && PARTY.test(v.slice(LOOP_PREFIX.length))

/** Session subject and Loop account key for a party. */
export const loopSubject = (party: string) => `${LOOP_PREFIX}${party}`

/** Party from the `loop:<party>` subject; null if not a Loop subject. */
export const loopPartyOf = (subject: string): string | null =>
  isLoopSubject(subject) ? subject.slice(LOOP_PREFIX.length) : null

/** Loop operation: the same as for the EVM account, plus a withdrawal to a Canton party. */
export type LoopAction =
  EvmAction | { kind: 'transfer-out'; symbol: string; amount: string; receiver: string }

export interface LoopMessageFields {
  /** Canton network from LoopWallet.network, e.g. canton:devnet */
  network: string
  /** Protocol operator party */
  operator: string
  /** Loop party of the account owner */
  party: string
  action: LoopAction
  /** debt instrument id, USDCx */
  debt: string
  nonce: number
  /** Signature expiry, ISO time to the second */
  expiresAt: string
}

/**
 * Operation text for `provider.signMessage`. The backend returns it with the command; the frontend
 * builds it itself from the user's intent and signs only if the texts match.
 */
export function loopMessage(f: LoopMessageFields): string {
  if (!PARTY.test(f.party)) throw new Error(`not a Canton party: ${f.party}`)
  if (!Number.isInteger(f.nonce) || f.nonce < 0) throw new Error(`bad nonce: ${f.nonce}`)
  return [
    'Canton Lending',
    evmActionLine(f.debt, f.action),
    `Account: ${f.party}`,
    `Network: ${f.network}`,
    `Operator: ${f.operator}`,
    `Nonce: ${f.nonce}`,
    `Expires: ${damlTime(f.expiresAt)}`,
  ].join('\n')
}

/** API sign-in message (off-ledger): nonce from the backend, party key in the text. */
export function loopLoginMessage(f: {
  host: string
  party: string
  /** Party public key: 64 hex, Ed25519 */
  publicKey: string
  network: string
  nonce: string
  issuedAt: string
  expiresAt: string
}): string {
  return [
    `${f.host} wants you to sign in to Canton Lending with your Loop wallet:`,
    f.party,
    '',
    'Signing is free and does not send a transaction.',
    '',
    `Public Key: ${f.publicKey}`,
    `Network: ${f.network}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expiresAt}`,
  ].join('\n')
}

/** Nonce from the sign-in text: the `Nonce: …` line; null if absent. */
export function loopLoginNonce(message: string): string | null {
  return /^Nonce: ([0-9a-f]{60})$/m.exec(message)?.[1] ?? null
}
