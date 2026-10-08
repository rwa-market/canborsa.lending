/**
 * Types shared by backend and frontend.
 * Money amounts are always strings (rule 8 in CLAUDE.md): the frontend does not recompute them.
 */

/** Decimal amount as a string, e.g. "1012.300000000000000000". */
export type Amount = string

/** Instrument identifier per the Token Standard (CIP-0056). */
export interface InstrumentId {
  admin: string
  id: string
}

export interface HealthResponse {
  status: 'ok'
  version: string
  ledger: 'connected' | 'unavailable'
  /** Build commit (RELEASE_SHA); null if not set */
  release?: string | null
}

export * from './api.ts'
export * from './evm.ts'
export * from './loop.ts'
export * from './price.ts'
