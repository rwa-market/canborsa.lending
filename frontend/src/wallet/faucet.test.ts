import { describe, expect, it } from 'vitest'
import { acceptTransferCommand } from './faucet.ts'
import { CommandRejected, type Intent, verifyPrepared } from './verify.ts'

const ALICE = 'alice::1220aaaaaaaaaaaaaaaa'
const MALLORY = 'mallory::1220bbbbbbbbbbbbbbbb'
const REGISTRY = 'usdcx-registry::1220dddddddddddddddd'
const OPERATOR = 'operator::1220cccccccccccccccc'
const ctx = { party: ALICE, operator: OPERATOR, now: new Date('2026-10-01T12:00:00Z') }
const instrument = { admin: REGISTRY, id: 'USDCx' }
const offer = { sender: REGISTRY, receiver: ALICE, instrumentId: instrument, amount: '1000' }
const intent = (over: Partial<Extract<Intent, { kind: 'accept-transfer' }>> = {}): Intent => ({
  kind: 'accept-transfer',
  offerCid: 'offer-1',
  instrument,
  amount: '1000',
  symbol: 'USDCx',
  offer,
  ...over,
})

describe('verifyPrepared: accept a faucet transfer', () => {
  it('accepts the transfer read from the node', () => {
    const s = verifyPrepared(acceptTransferCommand(ALICE, 'offer-1'), intent(), ctx)
    expect(s.title).toBe('Receive 1000 test USDCx')
    expect(s.lines.join(' ')).toMatch(/checked on your node/)
  })

  it('refuses another offer, party, sender, token or amount', () => {
    const cmd = acceptTransferCommand(ALICE, 'offer-1')
    const bad: Intent[] = [
      intent({ offerCid: 'offer-2' }),
      intent({ offer: { ...offer, receiver: MALLORY } }),
      intent({ offer: { ...offer, sender: MALLORY } }),
      intent({ offer: { ...offer, instrumentId: { admin: REGISTRY, id: 'CBTC' } } }),
      intent({ offer: { ...offer, amount: '1000000' } }),
    ]
    for (const i of bad) expect(() => verifyPrepared(cmd, i, ctx)).toThrow(CommandRejected)
    expect(() => verifyPrepared(acceptTransferCommand(MALLORY, 'offer-1'), intent(), ctx)).toThrow(
      CommandRejected,
    )
  })

  it('refuses extra arguments and disclosed contracts', () => {
    const withContext = acceptTransferCommand(ALICE, 'offer-1')
    ;(
      withContext.commands[0] as { ExerciseCommand: { choiceArgument: unknown } }
    ).ExerciseCommand.choiceArgument = {
      extraArgs: { context: { values: { x: 1 } }, meta: { values: {} } },
    }
    expect(() => verifyPrepared(withContext, intent(), ctx)).toThrow(CommandRejected)
    const withDisclosed = {
      ...acceptTransferCommand(ALICE, 'offer-1'),
      disclosedContracts: [{ contractId: 'x', createdEventBlob: 'b', templateId: 't' }],
    }
    expect(() => verifyPrepared(withDisclosed, intent(), ctx)).toThrow(CommandRejected)
  })

  it('without a read offer checks the shape and says so', () => {
    const s = verifyPrepared(acceptTransferCommand(ALICE, 'offer-1'), intent({ offer: null }), ctx)
    expect(s.lines.join(' ')).toMatch(/only the command shape is checked/)
  })
})
