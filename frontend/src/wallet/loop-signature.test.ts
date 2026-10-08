import { describe, expect, it } from 'vitest'
import { LoopSignatureError, normalizeLoopSignature } from './loop-signature.ts'

const BYTES = Uint8Array.from({ length: 64 }, (_, i) => i * 3)
const HEX = Array.from(BYTES, (b) => b.toString(16).padStart(2, '0')).join('')
const B64 = btoa(String.fromCharCode(...BYTES))
const B64URL = B64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const PUB = 'ab'.repeat(32)

describe('Loop signMessage payload', () => {
  it('turns every known shape of a 64-byte signature into lowercase hex', () => {
    const shapes: unknown[] = [
      HEX,
      HEX.toUpperCase(),
      `0x${HEX}`,
      ` ${HEX}\n`,
      B64,
      B64URL,
      BYTES,
      Array.from(BYTES),
      { signature: HEX },
      { signature: B64 },
      { signedMessage: B64 },
      { signature: { signature: HEX } },
      { result: { signature: Array.from(BYTES) } },
      JSON.stringify({ signature: B64 }),
    ]
    for (const s of shapes) expect(normalizeLoopSignature(s)).toBe(HEX)
  })

  it('passes an unknown single-token string through for the backend to judge', () => {
    expect(normalizeLoopSignature('abc.def-123')).toBe('abc.def-123')
  })

  it('refuses an empty answer, an object without a signature and wrong-length bytes', () => {
    for (const s of [undefined, null, '', '  ', {}, { ok: true }, 42, Array(10).fill(1)])
      expect(() => normalizeLoopSignature(s)).toThrow(LoopSignatureError)
  })

  it('refuses a text with spaces: that is not a signature', () => {
    expect(() => normalizeLoopSignature('user rejected the request')).toThrow(/unknown format/)
  })

  it('refuses a signature made with another key than the account key', () => {
    expect(normalizeLoopSignature({ signature: HEX, public_key: PUB.toUpperCase() }, PUB)).toBe(HEX)
    expect(() =>
      normalizeLoopSignature({ signature: HEX, publicKey: 'cd'.repeat(32) }, PUB),
    ).toThrow(/another key/)
  })
})
