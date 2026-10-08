import { describe, expect, it } from 'vitest'
import { COOLDOWN_MS, createFaucetLimiter, DAILY_PER_IP, DAILY_PER_PARTY } from '../src/faucet.ts'

describe('faucet limiter', () => {
  it('allows one portion per symbol per minute and caps the day per party and per IP', () => {
    let t = 0
    const l = createFaucetLimiter(() => t)
    expect(l.take('alice', 'USDCx', 'ip1').ok).toBe(true)
    expect(l.take('alice', 'USDCx', 'ip1').ok).toBe(false)
    // another symbol has its own queue
    expect(l.take('alice', 'CC', 'ip1').ok).toBe(true)
    for (let i = 1; i < DAILY_PER_PARTY; i++) {
      t += COOLDOWN_MS
      expect(l.take('alice', 'USDCx', 'ip1').ok).toBe(true)
    }
    t += COOLDOWN_MS
    const v = l.take('alice', 'USDCx', 'ip1')
    expect(v.ok).toBe(false)
    expect(!v.ok && v.reason).toMatch(/daily USDCx faucet limit/)
    // a day later the limit is open again
    t += 24 * 60 * 60_000
    expect(l.take('alice', 'USDCx', 'ip1').ok).toBe(true)
  })

  it('caps one network address across parties', () => {
    const l = createFaucetLimiter(() => 0)
    for (let i = 0; i < DAILY_PER_IP; i++) expect(l.take(`p${i}`, 'CC', 'ip9').ok).toBe(true)
    expect(l.take('someone-else', 'CC', 'ip9').ok).toBe(false)
    expect(l.take('someone-else', 'CC', 'ip10').ok).toBe(true)
  })
})
