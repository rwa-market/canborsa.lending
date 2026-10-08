/**
 * Loop wallet cryptography (0.7.0): party key, Canton fingerprint and verification of the
 * `provider.signMessage` signature. node:crypto only.
 *
 * A Canton fingerprint is the multihash SHA-256 of the key with hash purpose 12
 * (canton-docs: appdev/deep-dives/external-signing-topology.mdx, «Fingerprint»):
 *   fingerprint = 0x12 0x20 ‖ SHA-256(uint32be(12) ‖ keyBytes), in hex.
 * keyBytes is the key in the format it was registered with in the topology: for Wallet SDK
 * external parties it is the raw 32 Ed25519 bytes (the documentation vector matches on raw
 * bytes), for default Canton keys it is DER SPKI. Both encodings of the same key are accepted:
 * forging the binding requires a SHA-256 preimage of the party fingerprint.
 *
 * The format of Loop's signMessage response is undocumented (type any). The server Signer from the
 * same SDK returns the key as hex (32 bytes) and the signature as hex over the UTF-8 text: that is
 * the first variant checked. Then: base64, signature over SHA-256 of the text, ECDSA P-256 for an
 * SPKI key (passkey).
 */
import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto'

/**
 * DER SPKI prefix for Ed25519 (RFC 8410): SEQUENCE { AlgorithmIdentifier 1.3.101.112, BIT STRING }.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** Hash purpose of the public key fingerprint (HashPurpose.PublicKeyFingerprint). */
export const FINGERPRINT_PURPOSE = 12

/** Canton fingerprint of key bytes: `1220` and 64 hex. */
export function cantonFingerprint(keyBytes: Uint8Array): string {
  const purpose = Buffer.alloc(4)
  purpose.writeUInt32BE(FINGERPRINT_PURPOSE)
  const digest = createHash('sha256').update(purpose).update(keyBytes).digest('hex')
  return `1220${digest}`
}

export type Encoding = 'hex' | 'base64'

/** Possible byte readings of a string: hex (with or without 0x) and base64 / base64url. */
export function decodings(s: string): { encoding: Encoding; bytes: Buffer }[] {
  const out: { encoding: Encoding; bytes: Buffer }[] = []
  const t = s.trim()
  const hex = t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : t
  if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex))
    out.push({ encoding: 'hex', bytes: Buffer.from(hex, 'hex') })
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    const bytes = Buffer.from(t, 'base64')
    // Strictness: re-encoding matches the input (ignoring padding and the url alphabet)
    const norm = (v: string) => v.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
    if (bytes.length > 0 && norm(bytes.toString('base64')) === norm(t))
      out.push({ encoding: 'base64', bytes })
  }
  return out
}

export interface LoopPublicKey {
  kind: 'ed25519' | 'ec'
  key: KeyObject
  /** How the key arrived: string encoding and byte format */
  encoding: Encoding
  format: 'raw' | 'spki'
  /**
   * Canonical form for the message and LoopWallet.publicKey: hex of the raw 32 bytes (Ed25519) or
   * DER SPKI (EC)
   */
  canonical: string
  /** Key encodings the party fingerprint could have been taken from */
  fingerprintInputs: { format: 'raw' | 'spki'; bytes: Buffer }[]
}

export class LoopKeyError extends Error {}

/** Public key from the Loop response: hex or base64, raw 32 Ed25519 bytes or DER SPKI. */
export function parseLoopPublicKey(input: string): LoopPublicKey {
  if (input.length > 512) throw new LoopKeyError('public key is too long')
  for (const { encoding, bytes } of decodings(input)) {
    if (bytes.length === 32) return ed25519(bytes, encoding, 'raw')
    if (bytes.length === 44 && bytes.subarray(0, 12).equals(ED25519_SPKI_PREFIX))
      return ed25519(bytes.subarray(12), encoding, 'spki')
    let key: KeyObject
    try {
      key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
    } catch {
      continue
    }
    if (key.asymmetricKeyType === 'ec') {
      const spki = key.export({ format: 'der', type: 'spki' })
      return {
        kind: 'ec',
        key,
        encoding,
        format: 'spki',
        canonical: spki.toString('hex'),
        fingerprintInputs: [{ format: 'spki', bytes: spki }],
      }
    }
  }
  throw new LoopKeyError('public key: expected Ed25519 (32 bytes or DER SPKI) in hex or base64')
}

function ed25519(raw: Buffer, encoding: Encoding, format: 'raw' | 'spki'): LoopPublicKey {
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw])
  let key: KeyObject
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  } catch {
    throw new LoopKeyError('public key is not a valid Ed25519 key')
  }
  return {
    kind: 'ed25519',
    key,
    encoding,
    format,
    canonical: raw.toString('hex'),
    fingerprintInputs: [
      { format: 'raw', bytes: raw },
      { format: 'spki', bytes: spki },
    ],
  }
}

/** Fingerprint from a party ID `<hint>::<fingerprint>`; not a party: null. */
export function partyFingerprint(party: string): string | null {
  const i = party.lastIndexOf('::')
  if (i <= 0) return null
  const fp = party.slice(i + 2)
  return /^[0-9a-f]{68}$/.test(fp) ? fp : null
}

/**
 * The key yields the fingerprint from the party ID: which key encoding matched; no match: null.
 * A party whose fingerprint is not SHA-256 (not `1220…`) is not bound.
 */
export function bindsParty(key: LoopPublicKey, party: string): 'raw' | 'spki' | null {
  const fp = partyFingerprint(party)
  if (!fp) return null
  return key.fingerprintInputs.find((i) => cantonFingerprint(i.bytes) === fp)?.format ?? null
}

export interface SignatureMatch {
  encoding: Encoding
  /** What was signed: the UTF-8 text bytes or their SHA-256 */
  payload: 'utf8' | 'sha256'
  /** EC: DER or r‖s */
  dsa?: 'der' | 'ieee-p1363'
}

/** Signature `signature` by key `key` over text `message`: which variant matched, else null. */
export function verifyLoopSignature(
  key: LoopPublicKey,
  message: string,
  signature: string,
): SignatureMatch | null {
  if (signature.length > 1024) return null
  const utf8 = Buffer.from(message, 'utf8')
  const payloads = [
    { payload: 'utf8' as const, data: utf8 },
    { payload: 'sha256' as const, data: createHash('sha256').update(utf8).digest() },
  ]
  for (const { encoding, bytes } of decodings(signature)) {
    for (const { payload, data } of payloads) {
      if (key.kind === 'ed25519') {
        if (bytes.length !== 64) continue
        if (verify(null, data, key.key, bytes)) return { encoding, payload }
        continue
      }
      for (const dsa of ['der', 'ieee-p1363'] as const) {
        try {
          if (verify('sha256', data, { key: key.key, dsaEncoding: dsa }, bytes))
            return { encoding, payload, dsa }
        } catch {
          // signature is not in this form
        }
      }
    }
  }
  return null
}

/**
 * Signature from the signMessage response: the string as is or a string field of an object
 * (`signature` and similar names, one nesting level deep). Not found: null.
 */
export function extractSignature(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  for (const k of SIGNATURE_KEYS) if (typeof o[k] === 'string') return o[k]
  for (const k of ['payload', 'data', 'result'])
    if (o[k] && typeof o[k] === 'object') {
      const inner = extractSignature(o[k])
      if (inner) return inner
    }
  return null
}

const SIGNATURE_KEYS = ['signature', 'sig', 'signed_message', 'signedMessage', 'data', 'result']

/**
 * Shape of a value for the log: type, keys, lengths and matching encodings, without the values
 * themselves.
 */
export function shapeOf(raw: unknown, depth = 0): unknown {
  if (typeof raw === 'string')
    return {
      type: 'string',
      length: raw.length,
      decodes: decodings(raw).map((x) => `${x.encoding}:${x.bytes.length}`),
    }
  if (raw === null || typeof raw !== 'object') return { type: raw === null ? 'null' : typeof raw }
  if (Array.isArray(raw)) return { type: 'array', length: raw.length }
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, 20)
  return {
    type: 'object',
    keys: entries.map(([k]) => k),
    ...(depth < 2
      ? { fields: Object.fromEntries(entries.map(([k, v]) => [k, shapeOf(v, depth + 1)])) }
      : {}),
  }
}
