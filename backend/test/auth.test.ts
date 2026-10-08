import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CHALLENGE_TTL_MS, createAuth, SEAL_TTL_MS } from '../src/auth.ts'

const secret = 'x'.repeat(40)
const clock = (start = 1_800_000_000_000) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('login challenges (M1, L6)', () => {
  it("a stranger's challenge does not overwrite the victim's", () => {
    const auth = createAuth(secret)
    const victim = auth.challenge('alice::1220')
    // an attacker without sign-in requests a challenge for the same party any number of times
    for (let i = 0; i < 50; i++) auth.challenge('alice::1220')
    expect(auth.checkChallenge('alice::1220', victim)).toBe(true)
  })

  it('several outstanding challenges per party are all valid', () => {
    const auth = createAuth(secret)
    const a = auth.challenge('alice::1220')
    const b = auth.challenge('alice::1220')
    expect(a).not.toBe(b)
    expect(auth.checkChallenge('alice::1220', a)).toBe(true)
    expect(auth.checkChallenge('alice::1220', b)).toBe(true)
  })

  it('binds the nonce to the party, the server and the expiry', () => {
    const c = clock()
    const auth = createAuth(secret, c.now)
    const nonce = auth.challenge('alice::1220')
    expect(nonce).toMatch(/^[0-9a-f]{60}$/)
    expect(auth.checkChallenge('bob::1220', nonce)).toBe(false)
    expect(createAuth('y'.repeat(40), c.now).checkChallenge('alice::1220', nonce)).toBe(false)
    const tampered = `${'f'.repeat(12)}${nonce.slice(12)}`
    expect(auth.checkChallenge('alice::1220', tampered)).toBe(false)
    c.advance(CHALLENGE_TTL_MS)
    expect(auth.checkChallenge('alice::1220', nonce)).toBe(true)
    c.advance(1)
    expect(auth.checkChallenge('alice::1220', nonce)).toBe(false)
  })

  it('signs sessions and seals with different keys', () => {
    const auth = createAuth(secret)
    const token = auth.issue('alice::1220')
    expect(auth.verify(token)).toBe('alice::1220')
    // a token signed with AUTH_SECRET itself (old scheme) no longer passes
    const payload = token.split('.')[0]!
    const legacy = createHmac('sha256', secret).update(payload).digest('base64url')
    expect(auth.verify(`${payload}.${legacy}`)).toBeNull()
    // a session signature is not valid as a seal, and vice versa
    const seal = auth.sealCommand({ a: 1 })
    expect(auth.verify(`${payload}.${seal.split('.')[2]}`)).toBeNull()
  })
})

describe('sealed commands (M5)', () => {
  const body = { actAs: ['alice::1220'], commands: [{}], disclosedContracts: [] }

  it('accepts a fresh seal once and refuses the replay', () => {
    const auth = createAuth(secret)
    const seal = auth.sealCommand(body)
    expect(auth.checkSeal(body, seal)).toBe('ok')
    expect(auth.checkSeal(body, seal)).toBe('reused')
  })

  it('refuses an expired seal at the boundary', () => {
    const c = clock()
    const auth = createAuth(secret, c.now)
    const atLimit = auth.sealCommand(body)
    const pastLimit = auth.sealCommand(body)
    c.advance(SEAL_TTL_MS)
    expect(auth.checkSeal(body, atLimit)).toBe('ok')
    c.advance(1)
    expect(auth.checkSeal(body, pastLimit)).toBe('expired')
  })

  it('refuses a seal for another body or with a forged time', () => {
    const auth = createAuth(secret)
    const seal = auth.sealCommand(body)
    expect(auth.checkSeal({ ...body, commands: [{ x: 1 }] }, seal)).toBe('invalid')
    const [, id, sig] = seal.split('.')
    expect(auth.checkSeal(body, `${Date.now().toString(36)}0.${id}.${sig}`)).toBe('invalid')
    expect(auth.checkSeal(body, 'x')).toBe('invalid')
  })
})
