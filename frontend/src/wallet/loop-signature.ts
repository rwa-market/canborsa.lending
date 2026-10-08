/**
 * Loop wallet `provider.signMessage` response (@fivenorth/loop-sdk 0.15.0): SDK type is any,
 * the format is undocumented. The SDK returns the wallet response `payload` as is, so this handles
 * everything Canton wallets produce: a hex or base64 string, an object with a signature field
 * (including nested), a byte array. An Ed25519 signature is 64 bytes; such is converted to
 * lowercase hex without 0x. Other strings go to the backend as is: it verifies the signature
 * (it accepts hex and base64), and the frontend must not break sign-in over an unfamiliar wrapper.
 * Module without React and alias imports: vitest runs it.
 */

export class LoopSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoopSignatureError'
  }
}

const ED25519_BYTES = 64
const HEX = /^(?:0x)?([0-9a-fA-F]+)$/
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/
/** Keys under which wallets put the signature */
const SIGNATURE_KEYS = ['signature', 'signed_message', 'signedMessage', 'sig', 'result', 'data']
const PUBLIC_KEY_KEYS = ['public_key', 'publicKey']
const MAX_DEPTH = 3

const toHex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function base64Bytes(s: string): Uint8Array | null {
  if (!BASE64.test(s)) return null
  try {
    const std = s.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(std.padEnd(std.length + ((4 - (std.length % 4)) % 4), '='))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

const ED25519_SPKI_PREFIX = '302a300506032b6570032100'

/**
 * Canonical Ed25519 key form, as in the backend (parseLoopPublicKey): hex of the raw 32 bytes.
 * A DER SPKI key: its last 32 bytes. Any other key (EC passkey): null.
 */
export function canonicalLoopKey(k: string): string | null {
  const t = k.trim()
  const hex = HEX.exec(t)
  const bytesHex =
    hex && hex[1]!.length % 2 === 0
      ? hex[1]!.toLowerCase()
      : (() => {
          const b = base64Bytes(t)
          return b ? toHex(b) : null
        })()
  if (!bytesHex) return null
  if (bytesHex.length === 64) return bytesHex
  if (bytesHex.length === 88 && bytesHex.startsWith(ED25519_SPKI_PREFIX)) return bytesHex.slice(24)
  return null
}

/** Key in comparable form: lowercase hex, otherwise the string without whitespace. */
export function normalizeKey(k: string): string {
  const t = k.trim()
  const hex = HEX.exec(t)
  if (hex && hex[1]!.length % 2 === 0) return hex[1]!.toLowerCase()
  const b = base64Bytes(t)
  return b && b.length >= 32 ? toHex(b) : t
}

/** The same key in different encodings (hex/base64, raw or SPKI). */
function sameKey(a: string, b: string): boolean {
  const ca = canonicalLoopKey(a)
  const cb = canonicalLoopKey(b)
  if (ca && cb) return ca === cb
  return normalizeKey(a) === normalizeKey(b)
}

function fromString(raw: string): string {
  const s = raw.trim()
  if (!s) throw new LoopSignatureError('Loop returned an empty signature')
  const hex = HEX.exec(s)
  if (hex && hex[1]!.length === ED25519_BYTES * 2) return hex[1]!.toLowerCase()
  const b = base64Bytes(s)
  if (b && b.length === ED25519_BYTES) return toHex(b)
  // the response may have arrived as a JSON string
  if (s.startsWith('{')) {
    try {
      return normalizeLoopSignature(JSON.parse(s) as unknown)
    } catch (e) {
      if (e instanceof LoopSignatureError) throw e
    }
  }
  if (s.length > 4096 || /\s/.test(s))
    throw new LoopSignatureError('Loop returned a signature in an unknown format')
  return s
}

function isBytes(v: unknown): v is ArrayLike<number> {
  if (v instanceof Uint8Array) return true
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 255)
  )
}

/**
 * Signature from the signMessage response. `publicKey` is the provider key: if the response names a
 * different key, the wallet signed with the wrong account: refuse.
 */
export function normalizeLoopSignature(raw: unknown, publicKey?: string, depth = 0): string {
  if (depth > MAX_DEPTH) throw new LoopSignatureError('Loop returned no signature')
  if (typeof raw === 'string') return fromString(raw)
  if (isBytes(raw)) {
    if (raw.length !== ED25519_BYTES)
      throw new LoopSignatureError('Loop returned a signature of the wrong length')
    return toHex(raw)
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const k of PUBLIC_KEY_KEYS) {
      const pk = o[k]
      if (publicKey && typeof pk === 'string' && !sameKey(pk, publicKey))
        throw new LoopSignatureError('Loop signed with another key than your account')
    }
    for (const k of SIGNATURE_KEYS)
      if (o[k] !== undefined && o[k] !== null)
        return normalizeLoopSignature(o[k], publicKey, depth + 1)
  }
  throw new LoopSignatureError('Loop returned no signature')
}
