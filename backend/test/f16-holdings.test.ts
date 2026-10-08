/**
 * F-16: holdings are read page by page, filtered by owner and instrument; transfer inputs take
 * the largest first and only up to the amount, with a cap on the number of inputs.
 */
import { describe, expect, it } from 'vitest'
import type { ActiveContract, LedgerClient } from '../src/ledger/client.ts'
import {
  CommandError,
  createCommandBuilder,
  MAX_INPUT_HOLDINGS,
  selectInputs,
} from '../src/protocol/commands.ts'
import { createReader } from '../src/protocol/reader.ts'
import { account, d, holding, readerWith, registry, snapshot } from './fixtures.ts'

const cmdArg = (cmd: { commands: unknown[] }) =>
  (cmd.commands[0] as { ExerciseCommand: { choiceArgument: Record<string, unknown> } })
    .ExerciseCommand.choiceArgument

describe('F-16: input selection', () => {
  const alice = d.alice!
  const own = [
    holding('h500', alice, '500', d.usdcx),
    holding('h300', alice, '300', d.usdcx),
    holding('h200', alice, '200', d.usdcx),
    holding('h50', alice, '50', d.usdcx),
  ]

  it('takes the largest holdings until the amount is covered', () => {
    expect(selectInputs(own, '600')).toEqual(['h500', 'h300'])
    expect(selectInputs(own, '500')).toEqual(['h500'])
    expect(selectInputs(own, '1050')).toEqual(['h500', 'h300', 'h200', 'h50'])
  })

  it('refuses when the wallet holds less, or needs more inputs than the limit', () => {
    expect(() => selectInputs(own, '1050.0000000001')).toThrow(CommandError)
    const dust = Array.from({ length: MAX_INPUT_HOLDINGS + 5 }, (_, i) =>
      holding(`d${i}`, alice, '1', d.usdcx),
    )
    expect(selectInputs(dust, String(MAX_INPUT_HOLDINGS))).toHaveLength(MAX_INPUT_HOLDINGS)
    expect(() => selectInputs(dust, String(MAX_INPUT_HOLDINGS + 1))).toThrow(/merge/i)
  })

  it('supply picks inputs on the amount; the registry sees the same inputs', async () => {
    const calls: { inputHoldingCids: string[] }[] = []
    const c = createCommandBuilder(
      d,
      readerWith(snapshot(), account(), { [alice]: own }),
      registry(calls),
    )
    const cmd = await c.supply(alice, '600')
    const payment = cmdArg(cmd).payment as { inputHoldingCids: string[] }
    expect(payment.inputHoldingCids).toEqual(['h500', 'h300'])
    expect(calls[0]!.inputHoldingCids).toEqual(['h500', 'h300'])
  })

  it('inputs sent by the wallet are kept as they are', async () => {
    const c = createCommandBuilder(d, readerWith(snapshot(), account()), registry())
    const cmd = await c.supply(alice, '600', ['loop-1', 'loop-2'])
    expect((cmdArg(cmd).payment as { inputHoldingCids: string[] }).inputHoldingCids).toEqual([
      'loop-1',
      'loop-2',
    ])
  })
})

describe('F-16: reader filters by owner and instrument, one ACS read per wallet', () => {
  const alice = d.alice!
  const raw = (cid: string, owner: string, amount: string, instrumentId: unknown, lock = null) =>
    ({
      contractId: cid,
      templateId: 't',
      payload: {},
      createdEventBlob: 'b',
      synchronizerId: 's',
      interfaceView: { owner, amount, instrumentId, lock },
    }) as ActiveContract
  const acs = [
    raw('a-usdcx-small', alice, '5', d.usdcx),
    raw('a-usdcx-big', alice, '50', d.usdcx),
    raw('a-cc', alice, '1000', d.cc),
    raw('bob-usdcx', d.operator, '999', d.usdcx),
    raw('a-locked', alice, '70', d.usdcx, { holders: [] } as never),
    raw('fake-usdcx', alice, '1', { admin: 'someone::1220', id: 'USDCx' }),
  ]
  const ledger = (queries: string[]) =>
    ({
      query: async (party: string) => {
        queries.push(party)
        return acs
      },
      ledgerEnd: async () => 1,
    }) as unknown as LedgerClient

  it('holdings: own, unlocked, of this exact InstrumentId, largest first', async () => {
    const r = createReader(ledger([]), d)
    const hs = await r.holdings(alice, d.usdcx)
    expect(hs.map((h) => h.contract.contractId)).toEqual(['a-usdcx-big', 'a-usdcx-small'])
  })

  it('wallet balances of three instruments come from one ACS read', async () => {
    const queries: string[] = []
    const r = createReader(ledger(queries), d)
    const b = await r.walletBalances(alice)
    expect(b).toEqual({
      USDCx: '55.0000000000',
      CC: '1000.0000000000',
      CBTC: '0.0000000000',
    })
    expect(queries).toEqual([alice])
  })
})
