/**
 * Seam 2: deposits and redeems bots on ledger, registry and DA Utilities stubs.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { BRIDGE_TEMPLATES, REAL_PROFILES, REASON_META_KEY } from '../src/assets/profiles.ts'
import { createRealAssetsStore } from '../src/assets/store.ts'
import type { BurnMintFactory } from '../src/assets/utilities.ts'
import { attributedAddress, createDepositsBot } from '../src/bots/deposits.ts'
import { createRedeemsBot, type RedeemRequestPayload } from '../src/bots/redeems.ts'
import type { Deployment } from '../src/deployment.ts'
import { LedgerError, type LedgerClient } from '../src/ledger/client.ts'
import { INTERFACES, TEMPLATES } from '../src/ledger/ids.ts'
import { createMetrics } from '../src/metrics.ts'
import type { Evm } from '../src/protocol/evm.ts'
import type { Reader } from '../src/protocol/reader.ts'
import type { TokenRegistry } from '../src/protocol/registry.ts'
import { d, holding, log, p } from './fixtures.ts'

const profile = REAL_PROFILES.testnet
const custody = p('Custody')
const dep = { ...d, ...profile.instruments, evm: { custody } } as Deployment
const ADDRESS = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'

const instruction = (
  cid: string,
  o: {
    reason?: string
    instrument?: { admin: string; id: string }
    receiver?: string
    sender?: string
    amount?: string
  } = {},
) => ({
  contractId: cid,
  templateId: 'reg:TransferInstruction',
  createdEventBlob: 'b',
  synchronizerId: 's',
  payload: {},
  interfaceView: {
    transfer: {
      sender: o.sender ?? p('Sender'),
      receiver: o.receiver ?? custody,
      amount: o.amount ?? '0.5',
      instrumentId: o.instrument ?? profile.instruments.cbtc,
      meta: { values: o.reason === undefined ? {} : { [REASON_META_KEY]: o.reason } },
    },
  },
})

describe('deposit memo', () => {
  it('only the exact lowercase memo attributes a deposit', () => {
    expect(attributedAddress(`lending:evm:${ADDRESS}`)).toBe(ADDRESS)
    expect(attributedAddress(`lending:evm:${ADDRESS.toUpperCase().replace('0X', '0x')}`)).toBeNull()
    expect(attributedAddress(ADDRESS)).toBeNull()
    expect(attributedAddress(undefined)).toBeNull()
    expect(attributedAddress(`lending:evm:${ADDRESS}x`)).toBeNull()
  })
})

function depositsWith(
  instructions: ReturnType<typeof instruction>[],
  o: { fail?: (cid: string) => unknown } = {},
) {
  const store = createRealAssetsStore(new Database(':memory:'))
  const metrics = createMetrics()
  const received: [string, string, unknown][] = []
  const opened: string[] = []
  const ledger = {
    query: async (_party: string, f: { interfaceId?: string; templateId?: string }) =>
      f.interfaceId === INTERFACES.transferInstruction ? instructions : [],
    // the custodian transaction stream is empty: real-assets-custody.test.ts covers it
    ledgerEnd: async () => 0,
    prunedOffset: async () => 0,
    transactions: async () => ({ transactions: [], lastOffset: null, count: 0 }),
  } as unknown as LedgerClient
  const evm = {
    ensureAccount: async (a: string) => void opened.push(a),
    receiveAttributed: async (a: string, cid: string, accept: unknown) => {
      const err = o.fail?.(cid)
      if (err) throw err
      received.push([a, cid, accept])
      return { updateId: `upd-${cid}`, events: [] }
    },
  } as unknown as Evm
  const registry: TokenRegistry = {
    transferFactory: async () => {
      throw new Error('unused')
    },
    acceptContext: async (_i, cid) => ({
      extraArgs: { context: { values: { round: cid } }, meta: { values: {} } },
      disclosed: [],
    }),
  }
  const reader = { holdings: async () => [] } as unknown as Reader
  const step = createDepositsBot({
    ledger,
    reader,
    evm,
    registry,
    store,
    deployment: dep,
    profile,
    log,
    metrics,
  })
  return { step, store, received, opened, metrics }
}

describe('deposits bot', () => {
  it('credits a memo deposit once by instruction cid, opening the account first', async () => {
    const b = depositsWith([instruction('ti-1', { reason: `lending:evm:${ADDRESS}` })])
    await b.step()
    await b.step()
    expect(b.opened).toEqual([ADDRESS])
    expect(b.received).toHaveLength(1)
    expect(b.received[0]![0]).toBe(ADDRESS)
    expect(b.received[0]![2]).toEqual({
      extraArgs: { context: { values: { round: 'ti-1' } }, meta: { values: {} } },
      disclosed: [],
    })
    expect(b.store.seen('ti-1')).toBe('credited')
    expect(b.metrics.get('deposits_credited_total', { slot: 'cbtc' })).toBe(1)
  })

  it('quarantines deposits without a memo, with a foreign memo or an unknown instrument', async () => {
    const b = depositsWith([
      instruction('ti-none'),
      instruction('ti-bad', { reason: 'hello' }),
      instruction('ti-case', { reason: `lending:evm:${ADDRESS.replace('c', 'C')}` }),
      instruction('ti-xyz', {
        reason: `lending:evm:${ADDRESS}`,
        instrument: { admin: p('Xyz'), id: 'XYZ' },
      }),
      // a DevNet test token under the real profile is a foreign instrument
      instruction('ti-test', { reason: `lending:evm:${ADDRESS}`, instrument: d.cbtc }),
    ])
    await b.step()
    await b.step()
    expect(b.received).toHaveLength(0)
    const open = b.store.quarantineOpen()
    expect(open.map((r) => [r.id, r.cause])).toEqual([
      ['ti-none', 'no-reason'],
      ['ti-bad', 'bad-reason'],
      ['ti-case', 'bad-reason'],
      ['ti-xyz', 'unknown-instrument'],
      ['ti-test', 'unknown-instrument'],
    ])
    expect(b.store.quarantineCounts()).toEqual({
      'no-reason': 1,
      'bad-reason': 2,
      'unknown-instrument': 2,
    })
    expect(b.metrics.get('deposits_quarantine_open', { cause: 'bad-reason' })).toBe(2)
  })

  it('ignores outgoing transfers of the custody party and transfers to others', async () => {
    const b = depositsWith([
      instruction('ti-out', {
        sender: custody,
        receiver: p('Bob'),
        reason: `lending:evm:${ADDRESS}`,
      }),
      instruction('ti-other', { receiver: p('Bob'), reason: `lending:evm:${ADDRESS}` }),
    ])
    await b.step()
    expect(b.received).toHaveLength(0)
    expect(b.store.quarantineOpen()).toHaveLength(0)
  })

  it('a contract rejection goes to quarantine; a transient error is retried', async () => {
    let transient = true
    const b = depositsWith(
      [
        instruction('ti-rej', { reason: `lending:evm:${ADDRESS}` }),
        instruction('ti-net', { reason: `lending:evm:${ADDRESS}` }),
      ],
      {
        fail: (cid) =>
          cid === 'ti-rej'
            ? new LedgerError('x', 400, null, 'deposit reason does not match this EVM wallet')
            : cid === 'ti-net' && transient
              ? new Error('fetch failed')
              : null,
      },
    )
    await expect(b.step()).rejects.toThrow(/fetch failed/)
    expect(b.store.quarantineOpen().map((r) => [r.id, r.cause, r.detail])).toEqual([
      ['ti-rej', 'rejected', 'deposit reason does not match this EVM wallet'],
    ])
    expect(b.store.seen('ti-net')).toBeNull()
    transient = false
    await b.step()
    expect(b.received.map((r) => r[1])).toEqual(['ti-net'])
  })
})

const usdcx = profile.instruments.usdcx
const request = (
  requestId: string,
  amount = '100.123456',
  over: Partial<RedeemRequestPayload> = {},
) => ({
  contractId: `rr-${requestId}`,
  templateId: 'x:Lending.Evm:RedeemRequest',
  createdEventBlob: 'b',
  synchronizerId: 's',
  payload: {
    operator: d.operator,
    custody,
    address: ADDRESS,
    instrumentId: usdcx,
    amount,
    ethAddress: '0x1111111111111111111111111111111111111111',
    requestId,
    ...over,
  },
})

function redeemsWith(
  requests: ReturnType<typeof request>[],
  burnResult: (n: number) => unknown = () => null,
) {
  const store = createRealAssetsStore(new Database(':memory:'))
  const metrics = createMetrics()
  const submitted: { choice: string; arg: Record<string, unknown>; commandId: string }[] = []
  let burns = 0
  const active = new Set(requests.map((r) => r.contractId))
  const ledger = {
    query: async (_party: string, f: { templateId?: string }) => {
      if (f.templateId === TEMPLATES.redeemRequest)
        return requests.filter((r) => active.has(r.contractId))
      if (f.templateId === BRIDGE_TEMPLATES.userAgreement)
        return [{ contractId: 'agreement-1', payload: { user: custody } }]
      return []
    },
    submit: async (
      _a: string[],
      cmds: {
        ExerciseCommand: {
          contractId: string
          choice: string
          choiceArgument: Record<string, unknown>
        }
      }[],
      _d: unknown,
      _r: unknown,
      o: { commandId: string },
    ) => {
      const ex = cmds[0]!.ExerciseCommand
      if (ex.choice === 'BridgeUserAgreement_Burn') {
        const err = burnResult(++burns)
        if (err) throw err
      }
      submitted.push({ choice: ex.choice, arg: ex.choiceArgument, commandId: o.commandId })
      if (ex.choice.startsWith('RedeemRequest_')) active.delete(ex.contractId)
      return { updateId: `upd-${submitted.length}`, events: [] }
    },
  } as unknown as LedgerClient
  const reader = {
    holdings: async () => [
      holding('h-1', custody, '80', usdcx),
      holding('h-2', custody, '50', usdcx),
    ],
    evmWallet: async () => ({ contractId: 'wallet-1' }),
  } as unknown as Reader
  const outputs: unknown[] = []
  const burnMint: BurnMintFactory = {
    context: async (_i, inputs, outs) => {
      outputs.push([inputs, outs])
      return {
        factoryCid: 'factory-1',
        contextContractIds: {
          instrumentConfigurationCid: 'ic',
          appRewardConfigurationCid: 'arc',
          featuredAppRightCid: 'far',
        },
        disclosed: [],
      }
    },
  }
  const step = createRedeemsBot({
    ledger,
    reader,
    store,
    burnMint,
    deployment: dep,
    profile,
    log,
    metrics,
  })
  return { step, store, submitted, metrics, outputs, burns: () => burns }
}

describe('redeems bot', () => {
  it('burns in xReserve with reference = requestId, then completes the request once', async () => {
    const b = redeemsWith([request('req-1')])
    await b.step()
    await b.step()
    expect(b.submitted.map((s) => s.choice)).toEqual([
      'BridgeUserAgreement_Burn',
      'RedeemRequest_Complete',
    ])
    const burn = b.submitted[0]!
    expect(burn.arg).toMatchObject({
      amount: '100.123456',
      destinationDomain: '0',
      destinationRecipient: '0x1111111111111111111111111111111111111111',
      holdingCids: ['h-1', 'h-2'],
      requestId: 'req-1',
      reference: 'req-1',
      factoryCid: 'factory-1',
    })
    expect(burn.commandId).toBe('xreserve-burn-req-1')
    // change from two holdings 130 − 100.123456 goes to the custodian
    expect(b.outputs[0]).toEqual([['h-1', 'h-2'], [{ owner: custody, amount: '29.876544' }]])
    expect(b.submitted[1]!.arg).toEqual({ burnReference: 'upd-1' })
    expect(b.store.redeem('req-1')?.status).toBe('completed')
    expect(b.metrics.get('redeems_total', { outcome: 'completed' })).toBe(1)
  })

  it('a rejected burn refunds the wallet with the reason', async () => {
    const b = redeemsWith(
      [request('req-2')],
      () => new LedgerError('x', 400, null, 'xReserve is paused'),
    )
    await b.step()
    expect(b.submitted.map((s) => [s.choice, s.arg])).toEqual([
      [
        'RedeemRequest_Refund',
        { actor: custody, walletCid: 'wallet-1', reason: 'xReserve is paused' },
      ],
    ])
    expect(b.store.redeem('req-2')?.status).toBe('refunded')
  })

  it('a malformed request is refunded without a burn', async () => {
    const b = redeemsWith([request('req-3', '1.1234567')])
    await b.step()
    expect(b.burns()).toBe(0)
    expect(b.submitted[0]!.choice).toBe('RedeemRequest_Refund')
  })

  it('transient burn failure: retried with the same command id; burned requests only complete', async () => {
    const b = redeemsWith([request('req-4')], (n) => (n === 1 ? new Error('fetch failed') : null))
    await expect(b.step()).rejects.toThrow(/fetch failed/)
    expect(b.store.redeem('req-4')?.status).toBe('burning')
    await b.step()
    expect(b.submitted.map((s) => [s.choice, s.commandId])).toEqual([
      ['BridgeUserAgreement_Burn', 'xreserve-burn-req-4'],
      ['RedeemRequest_Complete', 'redeem-complete-req-4'],
    ])
    // after burn (status burned) but before Complete: only Complete, no second burn
    const c = redeemsWith([request('req-5')])
    c.store.setRedeem('req-5', 'rr-req-5', 'burned', { burnReference: 'upd-old' })
    await c.step()
    expect(c.burns()).toBe(0)
    expect(c.submitted).toEqual([
      {
        choice: 'RedeemRequest_Complete',
        arg: { burnReference: 'upd-old' },
        commandId: 'redeem-complete-req-5',
      },
    ])
  })

  it('a rejected retry after an unknown burn outcome is stuck, never refunded blindly', async () => {
    const b = redeemsWith([request('req-6')], (n) =>
      n === 1
        ? new Error('fetch failed')
        : new LedgerError('x', 400, null, 'CONTRACT_NOT_FOUND h-1'),
    )
    await expect(b.step()).rejects.toThrow()
    await b.step()
    expect(b.store.redeem('req-6')?.status).toBe('stuck')
    expect(b.submitted).toHaveLength(0)
    await b.step()
    expect(b.burns()).toBe(2)
  })

  it('duplicate burn command counts as burned and completes', async () => {
    const b = redeemsWith([request('req-7')], () => new Error('DUPLICATE_COMMAND'))
    await b.step()
    expect(b.submitted).toEqual([
      {
        choice: 'RedeemRequest_Complete',
        arg: { burnReference: 'request:req-7' },
        commandId: 'redeem-complete-req-7',
      },
    ])
  })
})
