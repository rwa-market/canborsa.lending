import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLeaderLease } from '../src/bots/leader.ts'

const file = () => join(mkdtempSync(join(tmpdir(), 'lease-')), 'bots.lease')

describe('bot leader lease', () => {
  it('lets one process lead and hands over on release', () => {
    const f = file()
    const blue = createLeaderLease({ file: f, pid: 1, isAlive: () => true })
    const green = createLeaderLease({ file: f, pid: 2, isAlive: () => true })
    expect(blue.tryAcquire()).toBe(true)
    expect(green.tryAcquire()).toBe(false)
    blue.release()
    expect(green.tryAcquire()).toBe(true)
  })

  it('takes over from a dead or silent holder', () => {
    const f = file()
    let t = 1_000
    const blue = createLeaderLease({ file: f, pid: 1, now: () => t, isAlive: () => true })
    expect(blue.tryAcquire()).toBe(true)
    const green = createLeaderLease({ file: f, pid: 2, now: () => t, isAlive: (p) => p !== 1 })
    expect(green.tryAcquire()).toBe(true) // the holder died
    const red = createLeaderLease({
      file: f,
      pid: 3,
      ttlMs: 15_000,
      now: () => t,
      isAlive: () => true,
    })
    expect(red.tryAcquire()).toBe(false)
    t += 16_000 // green has not renewed the lease for longer than ttl
    expect(red.tryAcquire()).toBe(true)
  })
})
