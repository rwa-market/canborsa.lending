/**
 * Seam 2: /evm/prepare for EvmTransferOut and EvmRedeem (Pool_EvmWalletExecute), redeem
 * rounded down to 6 places, /config.realAssets; on DevNet neither the new field nor new ops.
 */
import { evmMessage } from '@lending/shared'
import Fastify from 'fastify'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { createAuth } from '../src/auth.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { createCommandBuilder } from '../src/protocol/commands.ts'
import { createEvm } from '../src/protocol/evm.ts'
import type { Reader } from '../src/protocol/reader.ts'
import { protocolRoutes } from '../src/routes/protocol.ts'
import { account, d, holding, p, readerWith, registry, snapshot } from './fixtures.ts'

const wallet = privateKeyToAccount(
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
)
const ADDRESS = wallet.address.toLowerCase()
const custody = p('EvmCustody')
const receiver = p('Receiver')
const dd = { ...d, evm: { custody } }
const ETH = '0x1111111111111111111111111111111111111111'

function evmReader() {
  const s = snapshot()
  const held = [holding('c-1', custody, '800', d.usdcx), holding('c-2', custody, '90', d.cc)]
  const base = readerWith(s, account('0', '0'))
  const w = {
    contractId: 'wallet-1',
    templateId: 'x:Lending.Evm:EvmWallet',
    createdEventBlob: 'b',
    synchronizerId: 'sync',
    payload: {
      operator: d.operator,
      custody,
      address: ADDRESS,
      network: 'canton:testnet',
      nonce: '4',
      balances: [
        [d.usdcx, '500'],
        [d.cc, '60'],
      ],
    },
  }
  return {
    ...base,
    holdings: async (party: string, i: { admin: string; id: string }) =>
      party === custody
        ? held.filter(
            (h) => h.view.instrumentId === i || (h.view.instrumentId as typeof i).id === i.id,
          )
        : [],
    evmWallet: async (a: string) => (a === ADDRESS ? w : null),
    walletBalances: async () => ({ USDCx: '500' }),
  } as unknown as Reader
}

const info = {
  enabled: true,
  profile: 'real' as const,
  instruments: { usdcx: d.usdcx, cc: d.cc, cbtc: d.cbtc },
  custody,
  depositReasonPrefix: 'lending:evm:',
  xreserve: {
    chainId: 11155111,
    contract: '0x008888878f94c0d87defdf0b07f46b93c1934442',
    usdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    cantonDomain: 10001,
    recipient: custody,
    maxFee: '0',
  },
}

async function appWith(realAssets: boolean, submitted: unknown[][] = []) {
  const auth = createAuth('y'.repeat(32), Date.now, { sessionTtlMs: 600_000 })
  const ledger = {
    submit: async (actAs: string[], cmds: unknown[], dc: unknown, _r: unknown, o: unknown) => {
      submitted.push([actAs, cmds, dc, o])
      return { updateId: 'upd-1', events: [] }
    },
  } as unknown as LedgerClient
  const reader = evmReader()
  const commands = createCommandBuilder(dd, reader, registry())
  const evm = createEvm(dd, ledger, reader, commands)
  const app = Fastify()
  await app.register(
    protocolRoutes({
      deployment: dd,
      ledger,
      reader,
      commands,
      auth,
      networkId: 'canton:testnet',
      history: () => [],
      evm,
      ...(realAssets ? { realAssets: { info } } : {}),
    }),
  )
  return { app, headers: { authorization: `Bearer ${auth.issue(ADDRESS)}` } }
}

type Prepared = {
  actAs: string[]
  commands: { ExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> } }[]
  disclosedContracts: unknown[]
  evm: { action: Record<string, unknown>; nonce: number }
  message: string
  seal: string
  requestedAmount?: string
}

describe('/config on DevNet and with real assets', () => {
  it('DevNet: the /config body has exactly the keys it had before', async () => {
    const { app } = await appWith(false)
    const body = (await app.inject({ method: 'GET', url: '/config' })).json()
    expect(Object.keys(body).sort()).toEqual(
      ['evm', 'instruments', 'markets', 'network', 'networkId', 'roles', 'testFaucet'].sort(),
    )
    expect(body.realAssets).toBeUndefined()
  })

  it('real: /config.realAssets carries only public fields', async () => {
    const { app } = await appWith(true)
    const body = (await app.inject({ method: 'GET', url: '/config' })).json()
    expect(body.realAssets).toEqual(info)
  })
})

describe('/evm/prepare for real-asset withdrawals', () => {
  it('DevNet: transfer-out and redeem are unknown operations', async () => {
    const { app, headers } = await appWith(false)
    for (const payload of [
      { address: ADDRESS, op: 'redeem', amount: '1', ethAddress: ETH },
      { address: ADDRESS, op: 'transfer-out', symbol: 'USDCx', amount: '1', receiver },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/evm/prepare', payload, headers })
      expect(r.statusCode).toBe(400)
    }
  })

  it('transfer-out: Pool_EvmWalletExecute from the custody holdings, line with the instrument id', async () => {
    const submitted: unknown[][] = []
    const { app, headers } = await appWith(true, submitted)
    const r = await app.inject({
      method: 'POST',
      url: '/evm/prepare',
      payload: { address: ADDRESS, op: 'transfer-out', symbol: 'CC', amount: '25.5', receiver },
      headers,
    })
    expect(r.statusCode).toBe(200)
    const b = r.json() as Prepared
    expect(b.actAs).toEqual([custody])
    const ex = b.commands[0]!.ExerciseCommand
    expect(ex.choice).toBe('Pool_EvmWalletExecute')
    expect(ex.choiceArgument).toMatchObject({
      custody,
      configCid: 'cfg',
      walletCid: 'wallet-1',
      action: { tag: 'EvmTransferOut', value: { instrumentId: d.cc, amount: '25.5', receiver } },
      transfer: { factoryCid: 'f-cc', inputHoldingCids: ['c-2'] },
    })
    // Daml: "Send <amount> <instrumentId.id> to <receiver>" — the CC id is Amulet
    expect(b.message.split('\n')[1]).toBe(`Send 25.5 Amulet to ${receiver}`)
    expect(b.evm.action).toEqual({
      kind: 'transfer-out',
      symbol: 'Amulet',
      amount: '25.5',
      receiver,
    })
    expect(b.message).toBe(evmMessage(b.evm as never))
    // the signed operation is submitted by the custodian with a commandId from the nonce
    const { message, requestedAmount: _r, ...sealed } = b
    void _r
    const s = await app.inject({
      method: 'POST',
      url: '/evm/submit',
      payload: { ...sealed, signature: await wallet.signMessage({ message }) },
      headers,
    })
    expect(s.statusCode).toBe(200)
    expect(submitted.at(-1)![3]).toEqual({ commandId: `evm-${ADDRESS}-4` })
  })

  it('transfer-out refuses more than the wallet share and the custody party as receiver', async () => {
    const { app, headers } = await appWith(true)
    const over = await app.inject({
      method: 'POST',
      url: '/evm/prepare',
      payload: { address: ADDRESS, op: 'transfer-out', symbol: 'CC', amount: '61', receiver },
      headers,
    })
    expect(over.statusCode).toBe(422)
    expect(over.json().error).toMatch(/holds 60/)
    const self = await app.inject({
      method: 'POST',
      url: '/evm/prepare',
      payload: {
        address: ADDRESS,
        op: 'transfer-out',
        symbol: 'USDCx',
        amount: '1',
        receiver: custody,
      },
      headers,
    })
    expect(self.statusCode).toBe(422)
  })

  const redeem = async (amount: string) => {
    const { app, headers } = await appWith(true)
    return app.inject({
      method: 'POST',
      url: '/evm/prepare',
      payload: {
        address: ADDRESS,
        op: 'redeem',
        amount,
        ethAddress: ETH.toUpperCase().replace('0X', '0x'),
      },
      headers,
    })
  }

  it('redeem: exactly 6 decimals goes as is, no transfer arguments, a request id', async () => {
    const r = await redeem('100.123456')
    expect(r.statusCode).toBe(200)
    const b = r.json() as Prepared
    const arg = b.commands[0]!.ExerciseCommand.choiceArgument
    expect(arg.transfer).toBeNull()
    const value = (arg.action as { tag: string; value: Record<string, string> }).value
    expect((arg.action as { tag: string }).tag).toBe('EvmRedeem')
    expect(value.amount).toBe('100.123456')
    expect(value.ethAddress).toBe(ETH)
    expect(value.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(b.requestedAmount).toBeUndefined()
    // line from the debt instrument id, as in Lending.Evm.actionLine
    expect(b.message.split('\n')[1]).toBe(`Redeem 100.123456 USDCx to Ethereum ${ETH}`)
  })

  it('redeem: the 7th decimal is floored and the exact amount reported', async () => {
    const r = await redeem('100.1234569')
    expect(r.statusCode).toBe(200)
    const b = r.json() as Prepared
    expect(b.evm.action.amount).toBe('100.123456')
    expect(b.requestedAmount).toBe('100.1234569')
    expect(b.message.split('\n')[1]).toBe(`Redeem 100.123456 USDCx to Ethereum ${ETH}`)
  })

  it('redeem: below 0.000001 after flooring, or above the balance, is refused', async () => {
    expect((await redeem('0.0000009')).statusCode).toBe(422)
    const over = await redeem('500.0000001')
    // 500.0000001 → 500: exactly the balance, passes
    expect(over.statusCode).toBe(200)
    expect((await redeem('500.000001')).statusCode).toBe(422)
  })
})
