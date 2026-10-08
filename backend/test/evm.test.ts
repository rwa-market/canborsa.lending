/**
 * EVM wallet accounts (0.5.0, ADR-004): sign-in by message signature; an operation is an unsigned
 * Pool_EvmExecute command, personal_sign text and custodian submission with (r, s)
 * in the lower half of the order. The vector matches Test.Lending.EvmTest:test_evmVector.
 */
import { evmMessage } from '@lending/shared'
import Fastify from 'fastify'
import { parseSignature, serializeSignature } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { createAuth } from '../src/auth.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { createCommandBuilder } from '../src/protocol/commands.ts'
import { createEvm, recoverEvmSignature } from '../src/protocol/evm.ts'
import type { Reader } from '../src/protocol/reader.ts'
import { protocolRoutes } from '../src/routes/protocol.ts'
import { account, d, holding, p, readerWith, registry, snapshot } from './fixtures.ts'

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const wallet = privateKeyToAccount(KEY)
const ADDRESS = wallet.address.toLowerCase()
const custody = p('EvmCustody')
const dd = { ...d, evm: { custody } }

describe('EVM signature', () => {
  it('matches the Daml vector: key, r and s', async () => {
    const message = evmMessage({
      network: 'canton:devnet',
      operator: 'Operator::1220abcd',
      address: ADDRESS,
      action: { kind: 'supply', amount: '100', full: false },
      debt: 'USDCx',
      nonce: 0,
      expiresAt: '2030-01-01T00:00:00Z',
    })
    const sig = await recoverEvmSignature(message, await wallet.signMessage({ message }))
    expect(sig).toEqual({
      address: ADDRESS,
      publicKey:
        '4e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e47fd35c4215d1edf53e6f83de344615ce719bdb0fd878f6ed76f06dd277956de',
      r: 'ef8b5141f0a0d4d83f6bd5d3edcb1e9dba1a678bdc86b5171e8700494830078d',
      s: '5ff29cdac5cba77846ac18be043f6f4b8e2ea8480aff729c8913b4a74a7972c1',
    })
  })

  it('brings a high-s signature to the lower half (EIP-2): same key, same r', async () => {
    const message = 'x'
    const low = parseSignature(await wallet.signMessage({ message }))
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const high = serializeSignature({
      r: low.r,
      s: `0x${(n - BigInt(low.s)).toString(16).padStart(64, '0')}`,
      yParity: low.yParity === 0 ? 1 : 0,
    })
    const a = await recoverEvmSignature(message, high)
    expect(a.address).toBe(ADDRESS)
    expect(a.s).toBe(low.s.slice(2))
  })
})

/** Reader with the address account, the wallet and the custodian holdings. */
function evmReader(balance = '500') {
  const s = snapshot()
  const acc = {
    ...account('0', '0'),
    payload: { ...account('0', '0').payload, owner: custody, evmAddress: ADDRESS },
  }
  const base = readerWith(s, acc, {
    [custody]: [holding('c-1', custody, '800', d.usdcx)],
  })
  const w = {
    contractId: 'wallet-1',
    templateId: 'x:Lending.Evm:EvmWallet',
    createdEventBlob: 'b',
    synchronizerId: 'sync',
    payload: {
      operator: d.operator,
      custody,
      address: ADDRESS,
      network: 'canton:devnet',
      nonce: '3',
      balances: [[d.usdcx, balance]],
    },
  }
  return {
    ...base,
    evmWallet: async (a: string) => (a === ADDRESS ? w : null),
    evmDirectory: async () => null,
    walletBalances: async () => ({ USDCx: balance }),
  } as unknown as Reader
}

async function appWith(reader: Reader, submitted: unknown[][]) {
  const auth = createAuth('y'.repeat(32), Date.now, { sessionTtlMs: 600_000 })
  const ledger = {
    submit: async (actAs: string[], cmds: unknown[], _d: unknown, _r: unknown, o: unknown) => {
      submitted.push([actAs, cmds, o])
      return { updateId: 'upd-1', events: [] }
    },
  } as unknown as LedgerClient
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
      networkId: 'canton:devnet',
      history: () => [],
      evm,
    }),
  )
  return app
}

async function signIn(app: Awaited<ReturnType<typeof appWith>>) {
  const ch = await app.inject({
    method: 'POST',
    url: '/auth/evm/challenge',
    payload: { address: wallet.address },
    headers: { host: 'lending.test' },
  })
  expect(ch.statusCode).toBe(200)
  const { nonce, message } = ch.json() as { nonce: string; message: string }
  expect(message.startsWith('lending.test wants you to sign in to Canton Lending')).toBe(true)
  expect(message).toContain(ADDRESS)
  const signature = await wallet.signMessage({ message })
  const res = await app.inject({
    method: 'POST',
    url: '/auth/evm/login',
    payload: { address: ADDRESS, nonce, signature },
    headers: { host: 'lending.test' },
  })
  return { res, nonce, signature }
}

describe('EVM routes', () => {
  it('signs in by a wallet signature once; a replay and another key are refused', async () => {
    const app = await appWith(evmReader(), [])
    const { res, nonce, signature } = await signIn(app)
    expect(res.statusCode).toBe(200)
    const token = res.json().token as string
    const s = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(s.json().party).toBe(ADDRESS)
    const again = await app.inject({
      method: 'POST',
      url: '/auth/evm/login',
      payload: { address: ADDRESS, nonce, signature },
      headers: { host: 'lending.test' },
    })
    expect(again.statusCode).toBe(401)
    const other = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    )
    const ch = await app.inject({
      method: 'POST',
      url: '/auth/evm/challenge',
      payload: { address: ADDRESS },
      headers: { host: 'lending.test' },
    })
    const forged = await app.inject({
      method: 'POST',
      url: '/auth/evm/login',
      payload: {
        address: ADDRESS,
        nonce: ch.json().nonce,
        signature: await other.signMessage({ message: ch.json().message }),
      },
      headers: { host: 'lending.test' },
    })
    expect(forged.statusCode).toBe(401)
  })

  it('prepares Pool_EvmExecute, then submits it from the custody party with the signature', async () => {
    const submitted: unknown[][] = []
    const app = await appWith(evmReader(), submitted)
    const token = (await signIn(app)).res.json().token as string
    const headers = { authorization: `Bearer ${token}` }
    const prep = await app.inject({
      method: 'POST',
      url: '/evm/prepare',
      payload: { address: ADDRESS, op: 'supply', amount: '100' },
      headers,
    })
    expect(prep.statusCode).toBe(200)
    const body = prep.json() as {
      actAs: string[]
      commands: { ExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> } }[]
      evm: { nonce: number; expiresAt: string }
      message: string
      seal: string
    }
    expect(body.actAs).toEqual([custody])
    const ex = body.commands[0]!.ExerciseCommand
    expect(ex.choice).toBe('Pool_EvmExecute')
    expect(ex.choiceArgument.action).toEqual({
      tag: 'EvmSupply',
      value: { amount: '100', full: false },
    })
    expect(ex.choiceArgument.walletCid).toBe('wallet-1')
    expect((ex.choiceArgument.transfer as { inputHoldingCids: string[] }).inputHoldingCids).toEqual(
      ['c-1'],
    )
    expect(body.message.split('\n').slice(0, 2)).toEqual(['Canton Lending', 'Supply 100.0 USDCx'])
    expect(body.message).toContain('Nonce: 3')
    const { message, ...sealed } = body
    const signature = await wallet.signMessage({ message })
    const res = await app.inject({
      method: 'POST',
      url: '/evm/submit',
      payload: { ...sealed, signature },
      headers,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ updateId: 'upd-1' })
    const [actAs, cmds, opts] = submitted.at(-1) as [
      string[],
      { ExerciseCommand: { choiceArgument: { signature: Record<string, string> } } }[],
      { commandId: string },
    ]
    expect(actAs).toEqual([custody])
    const sig = cmds[0]!.ExerciseCommand.choiceArgument.signature
    expect(sig.publicKey).toHaveLength(128)
    expect(sig.r).toHaveLength(64)
    expect(opts.commandId).toBe(`evm-${ADDRESS}-3`)
    // the same seal does not pass a second time; a tampered amount breaks the seal
    const replay = await app.inject({
      method: 'POST',
      url: '/evm/submit',
      payload: { ...sealed, signature },
      headers,
    })
    expect(replay.statusCode).toBe(422)
    const tampered = structuredClone(sealed)
    tampered.commands[0]!.ExerciseCommand.choiceArgument.action = {
      tag: 'EvmSupply',
      value: { amount: '1' },
    }
    const t = await app.inject({
      method: 'POST',
      url: '/evm/submit',
      payload: { ...tampered, signature },
      headers,
    })
    expect(t.statusCode).toBe(403)
  })

  it('refuses a payment above the wallet share and a signature of another wallet', async () => {
    const app = await appWith(evmReader('50'), [])
    const token = (await signIn(app)).res.json().token as string
    const headers = { authorization: `Bearer ${token}` }
    const over = await app.inject({
      method: 'POST',
      url: '/evm/prepare',
      payload: { address: ADDRESS, op: 'supply', amount: '100' },
      headers,
    })
    expect(over.statusCode).toBe(422)
    expect(over.json().error).toMatch(/holds 50/)
    const prep = (
      await app.inject({
        method: 'POST',
        url: '/evm/prepare',
        payload: { address: ADDRESS, op: 'supply', amount: '10' },
        headers,
      })
    ).json()
    const { message, ...sealed } = prep
    const other = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    )
    const res = await app.inject({
      method: 'POST',
      url: '/evm/submit',
      payload: { ...sealed, signature: await other.signMessage({ message }) },
      headers,
    })
    expect(res.statusCode).toBe(401)
  })

  it('an EVM session cannot prepare for another address', async () => {
    const app = await appWith(evmReader(), [])
    const token = (await signIn(app)).res.json().token as string
    const res = await app.inject({
      method: 'POST',
      url: '/evm/prepare',
      payload: {
        address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        op: 'supply',
        amount: '10',
      },
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
