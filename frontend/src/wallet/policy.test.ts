import { describe, expect, it } from 'vitest'
import { ceilTo, cmp, floorTo, mulRatio, sum } from '../lib/decimal.ts'
import { pickInputs, totalOf } from './holdings.ts'
import { commandIdFor, intentKey, settle } from './intentId.ts'
import { checkNetwork, expectedNetwork } from './network.ts'
import { expiryDelay, liveSession, restorePlan } from './session.ts'

describe('decimal strings', () => {
  it('adds and compares exactly, without floats', () => {
    expect(sum(['0.1', '0.2'])).toBe('0.3')
    expect(sum(['123456789012.0000000001', '0.0000000009'])).toBe('123456789012.000000001')
    expect(cmp('100', '100.000')).toBe(0)
    expect(cmp('99.9999999999', '100')).toBe(-1)
  })
  it('rounds in the stated direction', () => {
    expect(ceilTo('12.34567890121', 10)).toBe('12.3456789013')
    expect(floorTo('12.34567890129', 10)).toBe('12.3456789012')
    expect(mulRatio('500', 101n, 100n)).toBe('505')
  })
  it('rejects what is not a plain non-negative decimal', () => {
    expect(() => cmp('1e5', '1')).toThrow()
    expect(() => cmp('-1', '1')).toThrow()
  })
})

describe('network check is fail-closed (F-4)', () => {
  const base = {
    expected: 'canton:da-testnet',
    pinned: null,
    wallet: 'canton:da-testnet',
    walletConnected: true,
    allowUndeclared: false,
  }
  it('passes only on the same, reported network', () => {
    expect(checkNetwork(base).ok).toBe(true)
    expect(checkNetwork({ ...base, wallet: 'canton:da-mainnet' })).toMatchObject({
      ok: false,
      reason: /mainnet/,
    })
    expect(checkNetwork({ ...base, wallet: null }).ok).toBe(false)
    expect(checkNetwork({ ...base, walletConnected: false }).ok).toBe(false)
  })
  it('blocks when the server declares nothing, except in dev', () => {
    expect(checkNetwork({ ...base, expected: null }).ok).toBe(false)
    expect(checkNetwork({ ...base, expected: null, allowUndeclared: true }).ok).toBe(true)
  })
  it('blocks when the build and the server disagree', () => {
    expect(checkNetwork({ ...base, pinned: 'canton:da-mainnet' })).toMatchObject({
      ok: false,
      reason: /built for/,
    })
  })
  it('reads /config.network as a string or an object, networkId as a fallback', () => {
    expect(expectedNetwork({ network: 'canton:a' })).toBe('canton:a')
    expect(expectedNetwork({ network: { networkId: 'canton:b', synchronizerId: 'x' } })).toBe(
      'canton:b',
    )
    expect(expectedNetwork({ networkId: 'canton:c' })).toBe('canton:c')
    expect(expectedNetwork({ networkId: null })).toBeNull()
  })
})

describe('input holdings (F-16)', () => {
  const hs = [
    { cid: 'small', amount: '1' },
    { cid: 'big', amount: '80' },
    { cid: 'mid', amount: '30' },
  ]
  it('takes the largest first until the amount is covered', () => {
    expect(pickInputs(hs, '50')).toEqual(['big'])
    expect(pickInputs(hs, '100')).toEqual(['big', 'mid'])
    expect(pickInputs(hs, null)).toEqual(['big', 'mid', 'small'])
  })
  it('caps the number of inputs', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ cid: `h${i}`, amount: '1' }))
    expect(pickInputs(many, '1000')).toHaveLength(50)
  })
  it('sums the wallet balance exactly (F-10)', () => {
    expect(totalOf(hs)).toBe('111')
  })
})

describe('commandId per intent (F-6)', () => {
  it('keeps the id after an ambiguous failure, forgets it after a clear outcome', () => {
    const key = intentKey('alice::1', 'supply', { amount: '5' })
    const first = commandIdFor(key, 0)
    settle(key, first, true, 0)
    expect(commandIdFor(key, 1_000)).toBe(first)
    expect(commandIdFor(key, 11 * 60_000)).not.toBe(first)
    const next = commandIdFor(key, 0)
    settle(key, next, false, 0)
    expect(commandIdFor(key, 1)).not.toBe(next)
  })
})

describe('cookie session (F-15)', () => {
  const party = 'alice::1220aaaaaaaa'
  const at = (ms: number) => new Date(ms).toISOString()

  it('accepts a live server session of a well-formed party only', () => {
    expect(liveSession({ party, expiresAt: at(2_000) }, 1_000)).toEqual({
      party,
      expiresAt: at(2_000),
    })
    expect(liveSession({ party, expiresAt: at(2_000) }, 2_000)).toBeNull()
    expect(liveSession({ party: 'alice', expiresAt: at(2_000) }, 1_000)).toBeNull()
    expect(liveSession({ party, expiresAt: 'tomorrow' }, 1_000)).toBeNull()
    expect(liveSession({ error: 'sign in with your wallet first' }, 1_000)).toBeNull()
    expect(liveSession(null, 1_000)).toBeNull()
  })

  it('accepts a Loop session subject loop:<party> and nothing else with the prefix', () => {
    const loop = `loop:${party}`
    expect(liveSession({ party: loop, expiresAt: at(2_000) }, 1_000)?.party).toBe(loop)
    expect(liveSession({ party: 'loop:alice', expiresAt: at(2_000) }, 1_000)).toBeNull()
    expect(liveSession({ party: `evm:${party}`, expiresAt: at(2_000) }, 1_000)).toBeNull()
  })

  it('never carries a token: the parsed session has only party and expiry', () => {
    const s = liveSession({ party, expiresAt: at(2_000), token: 'secret.x' }, 1_000)
    expect(s && Object.keys(s).sort()).toEqual(['expiresAt', 'party'])
  })

  it('schedules the reset at expiry, clamped for setTimeout', () => {
    expect(expiryDelay(at(5_000), 1_000)).toBe(4_000)
    expect(expiryDelay(at(500), 1_000)).toBe(0)
    expect(expiryDelay('garbage', 1_000)).toBe(0)
    expect(expiryDelay(at(1_000 + 2 ** 32), 1_000)).toBe(2 ** 31 - 1)
  })

  it('accepts no EVM address session: users sign in with Loop only', () => {
    const address = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'
    expect(liveSession({ party: address, expiresAt: at(2_000) }, 1_000)).toBeNull()
  })

  it('restores Loop anywhere, nothing without a session or a hint', () => {
    const s = { party, expiresAt: at(2_000) }
    expect(restorePlan(s, 'loop', '/')).toBe('loop')
    expect(restorePlan(s, 'loop', '/operator')).toBe('loop')
    expect(restorePlan(null, 'loop')).toBe('none')
    expect(restorePlan(s, null, '/operator')).toBe('none')
  })

  it('restores the node wallet only on protocol role pages', () => {
    const s = { party, expiresAt: at(2_000) }
    for (const path of ['/operator', '/admin', '/liquidations', '/council'])
      expect(restorePlan(s, 'node', path)).toBe('node')
    expect(restorePlan(s, 'node', '/auth/callback')).toBe('node-callback')
    for (const path of ['/', '/markets', '/history', '/operatorx'])
      expect(restorePlan(s, 'node', path)).toBe('none')
    expect(restorePlan(null, 'node', '/operator')).toBe('none')
  })

  it('drops a remembered EVM wallet from an older build', () => {
    const s = { party, expiresAt: at(2_000) }
    expect(restorePlan(s, 'evm' as never, '/')).toBe('none')
  })
})
