import { loopLoginMessage } from '@lending/shared'
import { describe, expect, it } from 'vitest'
import {
  type LoopMessageFields,
  loopMessage,
  type LoopPreparedResponse,
  verifyLoopLogin,
  verifyLoopPrepared,
} from './loop-verify.ts'
import { CommandRejected, type Intent } from './verify.ts'

const PARTY = 'alice-loop::1220aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OPERATOR = 'operator::1220cccccccccccccccc'
const CUSTODY = 'custody::1220dddddddddddddddd'
const NOW = new Date('2026-10-01T12:00:00Z')
const ctx = {
  party: PARTY,
  operator: OPERATOR,
  network: 'canton:devnet',
  custody: CUSTODY,
  now: NOW,
}

function prepared(
  over: Partial<LoopMessageFields> = {},
  tamper?: (a: Record<string, unknown>, p: LoopPreparedResponse) => void,
  tag = 'EvmSupply',
  value: Record<string, unknown> = { amount: '100', full: false },
): LoopPreparedResponse {
  const loop: LoopMessageFields = {
    network: 'canton:devnet',
    operator: OPERATOR,
    party: PARTY,
    action: { kind: 'supply', amount: '100', full: false },
    debt: 'USDCx',
    nonce: 4,
    expiresAt: '2026-10-01T12:10:00.000Z',
    ...over,
  }
  const message = loopMessage(loop)
  const arg: Record<string, unknown> = {
    custody: CUSTODY,
    action: { tag, value },
    signedMessage: message,
    // /loop/submit inserts the signature
    signature: '',
    nonce: '4',
    expiresAt: loop.expiresAt,
  }
  const p: LoopPreparedResponse = {
    actAs: [CUSTODY],
    commands: [{ ExerciseCommand: { choice: 'Pool_LoopWalletExecute', choiceArgument: arg } }],
    disclosedContracts: [],
    loop,
    seal: 's',
    message,
  }
  tamper?.(arg, p)
  return p
}

const supply: Intent = { kind: 'supply', amount: '100' }

describe('Loop operation text', () => {
  it('names the action, the Loop party, the network, the operator, nonce and expiry', () => {
    expect(loopMessage(prepared().loop)).toBe(
      [
        'Canton Lending',
        'Supply 100.0 USDCx',
        `Account: ${PARTY}`,
        'Network: canton:devnet',
        `Operator: ${OPERATOR}`,
        'Nonce: 4',
        'Expires: 2026-10-01T12:10:00Z',
      ].join('\n'),
    )
  })

  it('refuses a malformed party', () => {
    expect(() => loopMessage({ ...prepared().loop, party: '0xabc' })).toThrow(/party/)
  })
})

describe('Loop operation check before signing', () => {
  it('passes what the user entered and shows the exact text', () => {
    const s = verifyLoopPrepared(prepared(), supply, ctx)
    expect(s.title).toBe('Supply 100.0 USDCx')
    expect(s.message).toBe(prepared().message)
  })

  it('a repayment keeps its name although the signed text says Supply (review 08.10, item 6)', () => {
    const s = verifyLoopPrepared(prepared(), { ...supply, kind: 'repay' }, ctx)
    expect(s.title).toBe(`Repay ${supply.amount} USDCx`)
    expect(s.lines[0]).toContain('Loop shows "Supply 100.0 USDCx"')
    expect(s.message).toBe(prepared().message)
  })

  it('refuses another amount, account, operator, network or sender', () => {
    const bad = [
      prepared({ action: { kind: 'supply', amount: '1000', full: false } }),
      prepared({ party: 'mallory::1220eeeeeeeeeeeeeeee' }),
      prepared({ operator: 'evil::1220eeeeeeeeeeeeeeee' }),
      prepared({ network: 'canton:mainnet' }),
      // the debt token in the signed text is fixed (audit): not renamed by the server
      prepared({ debt: 'USDT' }),
      { ...prepared(), actAs: ['evil::1220eeeeeeeeeeeeeeee'] },
    ]
    for (const p of bad) expect(() => verifyLoopPrepared(p, supply, ctx)).toThrow(CommandRejected)
  })

  it('refuses a server text that differs from the fields, even by one character', () => {
    const p = prepared()
    expect(() =>
      verifyLoopPrepared({ ...p, message: p.message.replace('100.0', '100.00') }, supply, ctx),
    ).toThrow(/text to sign differs/)
    expect(() => verifyLoopPrepared({ ...p, message: `${p.message}\n` }, supply, ctx)).toThrow(
      /text to sign differs/,
    )
  })

  it('refuses a command that records another text, nonce, expiry or action', () => {
    const cases: [(a: Record<string, unknown>) => void, RegExp][] = [
      [(a) => (a.signedMessage = 'Canton Lending\nSupply 1.0 USDCx'), /records another text/],
      [(a) => (a.signedMessage = ''), /records another text/],
      [(a) => (a.nonce = '9'), /nonce differs/],
      [(a) => (a.expiresAt = '2026-10-01T12:20:00Z'), /expiry differs/],
      [(a) => (a.action = { tag: 'EvmBorrow', value: { amount: '100' } }), /action differs/],
      [
        (a) => (a.action = { tag: 'LoopSupply', value: { amount: '100', full: false } }),
        /action differs/,
      ],
      [
        (a) => (a.action = { tag: 'EvmSupply', value: { amount: '5', full: false } }),
        /amount differs/,
      ],
      [
        (a) => (a.action = { tag: 'EvmSupply', value: { amount: '100', full: true } }),
        /full differs/,
      ],
      [(a) => (a.custody = 'evil::1220eeeeeeeeeeeeeeee'), /another custody/],
    ]
    for (const [tamper, why] of cases)
      expect(() => verifyLoopPrepared(prepared({}, tamper), supply, ctx)).toThrow(why)
  })

  it('refuses another choice and more than one command', () => {
    const other = prepared({}, (_a, p) => {
      ;(p.commands[0] as { ExerciseCommand: { choice: string } }).ExerciseCommand.choice =
        'Pool_EvmExecute'
    })
    expect(() => verifyLoopPrepared(other, supply, ctx)).toThrow(/unexpected choice/)
    const two = prepared({}, (_a, p) => p.commands.push(p.commands[0]))
    expect(() => verifyLoopPrepared(two, supply, ctx)).toThrow(/exactly one command/)
  })

  it('refuses an expiry in the past or more than 30 minutes ahead', () => {
    for (const expiresAt of ['2026-10-01T11:59:00.000Z', '2026-10-01T12:40:00.000Z'])
      expect(() => verifyLoopPrepared(prepared({ expiresAt }), supply, ctx)).toThrow(/expiry/)
  })

  it('repay all is a supply with full, bounded by the debt', () => {
    const p = prepared(
      { action: { kind: 'supply', amount: '100.1', full: true } },
      undefined,
      'EvmSupply',
      { amount: '100.1', full: true },
    )
    const all: Intent = { kind: 'repay', amount: 'max', debt: '100' }
    expect(verifyLoopPrepared(p, all, ctx).title).toBe('Repay all USDCx debt, up to 100.1')
    expect(() => verifyLoopPrepared(p, { ...all, debt: '50' }, ctx)).toThrow(/above your debt/)
    // without the debt snapshot there is no bound: refused, not signed unbounded (audit)
    expect(() => verifyLoopPrepared(p, { kind: 'repay', amount: 'max' }, ctx)).toThrow(
      /needs your current debt/,
    )
    // the server text must not drop "all" for a typed amount
    expect(() => verifyLoopPrepared(p, { kind: 'repay', amount: '100.1' }, ctx)).toThrow(
      /repayment amount differs/,
    )
  })

  it('withdraw and borrow are different texts and tags (risk 7)', () => {
    const borrow = prepared({ action: { kind: 'borrow', amount: '300' } }, undefined, 'EvmBorrow', {
      amount: '300',
    })
    expect(verifyLoopPrepared(borrow, { kind: 'borrow', amount: '300' }, ctx).title).toBe(
      'Borrow 300.0 USDCx',
    )
    expect(() => verifyLoopPrepared(borrow, { kind: 'withdraw', amount: '300' }, ctx)).toThrow(
      /not a withdrawal/,
    )
    const withdraw = prepared(
      { action: { kind: 'withdraw', amount: '300', full: false } },
      undefined,
      'EvmWithdraw',
      { amount: '300', full: false },
    )
    expect(verifyLoopPrepared(withdraw, { kind: 'withdraw', amount: '300' }, ctx).title).toBe(
      'Withdraw 300.0 USDCx',
    )
    // the text says withdraw, the command borrows: refused
    const swapped = prepared(
      { action: { kind: 'withdraw', amount: '300', full: false } },
      undefined,
      'EvmBorrow',
      { amount: '300' },
    )
    expect(() => verifyLoopPrepared(swapped, { kind: 'withdraw', amount: '300' }, ctx)).toThrow(
      /action differs/,
    )
  })

  it('collateral deposit by market', () => {
    const p = prepared(
      { action: { kind: 'deposit-collateral', marketId: 'CC', amount: '20000' } },
      undefined,
      'EvmDepositCollateral',
      { marketId: 'CC', amount: '20000' },
    )
    const intent: Intent = { kind: 'deposit-collateral', marketId: 'CC', amount: '20000' }
    expect(verifyLoopPrepared(p, intent, ctx).title).toBe('Deposit 20000.0 CC as collateral')
    expect(() => verifyLoopPrepared(p, { ...intent, marketId: 'CBTC' }, ctx)).toThrow(
      /deposit differs/,
    )
  })

  it('refuses operations a Loop wallet does not run', () => {
    expect(() =>
      verifyLoopPrepared(prepared(), { kind: 'add-reserves', amount: '1' }, ctx),
    ).toThrow(/not a lending wallet operation/)
  })
})

describe('Loop sign-in text', () => {
  const KEY = 'ab'.repeat(32)
  const NONCE = '0'.repeat(59) + '1'
  // as the backend builds it
  const message = loopLoginMessage({
    host: 'lending.example',
    party: PARTY,
    publicKey: KEY,
    network: 'canton:devnet',
    nonce: NONCE,
    issuedAt: '2026-10-01T12:00:00.000Z',
    expiresAt: '2026-10-01T12:05:00.000Z',
  })
  const want = {
    host: 'lending.example',
    party: PARTY,
    publicKey: KEY,
    network: 'canton:devnet',
    nonce: NONCE,
    now: NOW,
  }

  it('matches the key in any encoding the provider reports', () => {
    const b64 = btoa(String.fromCharCode(...Array(32).fill(0xab)))
    const spki = `302a300506032b6570032100${KEY}`
    for (const publicKey of [KEY.toUpperCase(), `0x${KEY}`, b64, spki])
      expect(() => verifyLoopLogin(message, { ...want, publicKey })).not.toThrow()
  })

  it('passes a text for this site, party, network and nonce', () => {
    expect(() => verifyLoopLogin(message, want)).not.toThrow()
  })

  it('refuses another site, party, network, nonce or an expired text', () => {
    const bad: [Partial<typeof want>, RegExp][] = [
      [{ host: 'evil.example' }, /another site/],
      [{ party: 'mallory::1220eeeeeeeeeeeeeeee' }, /another account/],
      [{ network: 'canton:mainnet' }, /another network/],
      [{ publicKey: 'cd'.repeat(32) }, /another key/],
      [{ nonce: '9'.repeat(60) }, /malformed/],
      [{ now: new Date('2026-10-01T13:00:00Z') }, /expired/],
    ]
    for (const [over, why] of bad)
      expect(() => verifyLoopLogin(message, { ...want, ...over })).toThrow(why)
  })
})
