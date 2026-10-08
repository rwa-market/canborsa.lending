/**
 * Loop wallet (0.7.0): party Canton key fingerprint, backend Ed25519 signature check,
 * challenge sign-in, Pool_LoopWalletExecute from the custodian, faucet to LoopWallet.
 */
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { loopMessage, loopSubject } from '@lending/shared'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createAuth } from '../src/auth.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { createCommandBuilder } from '../src/protocol/commands.ts'
import { createLoop, LoopError, type LoopSealedBody } from '../src/protocol/loop.ts'
import {
  bindsParty,
  cantonFingerprint,
  extractSignature,
  LoopKeyError,
  parseLoopPublicKey,
  verifyLoopSignature,
} from '../src/protocol/loop-crypto.ts'
import type { Reader } from '../src/protocol/reader.ts'
import { protocolRoutes } from '../src/routes/protocol.ts'
import { account, d, holding, p, readerWith, registry, snapshot } from './fixtures.ts'

/** Ed25519 key and a party with its fingerprint, like a Wallet SDK external party. */
function loopUser(hint = 'loop-alice') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  return {
    raw,
    hex: raw.toString('hex'),
    spki: publicKey.export({ format: 'der', type: 'spki' }),
    party: `${hint}::${cantonFingerprint(raw)}`,
    privateKey,
    sign: (message: string, enc: 'hex' | 'base64' = 'hex') =>
      sign(null, Buffer.from(message, 'utf8'), privateKey).toString(enc),
  }
}
const signWith = (k: KeyObject, data: Buffer) => sign(null, data, k).toString('hex')

describe('Canton fingerprint', () => {
  it('matches the vector from the Canton docs (external-signing-topology, base64 key)', () => {
    // compute_canton_fingerprint_from_base64 "2RwUiIHVUVdulxzD8NKtPmIaaBqMer1A90rDjoklJPY="
    const raw = Buffer.from('2RwUiIHVUVdulxzD8NKtPmIaaBqMer1A90rDjoklJPY=', 'base64')
    expect(cantonFingerprint(raw)).toBe(
      '1220205057e331cc8929dd217e2f8e63f503b7081773de60d01fb46839700bc5caaa',
    )
  })

  it('binds a key to its party in every encoding, and not to another party', () => {
    const u = loopUser()
    for (const form of [
      u.hex,
      `0x${u.hex}`,
      u.raw.toString('base64'),
      u.spki.toString('hex'),
      u.spki.toString('base64'),
    ]) {
      const key = parseLoopPublicKey(form)
      expect(key.canonical).toBe(u.hex)
      expect(bindsParty(key, u.party)).toBe('raw')
    }
    // A party registered with a DER SPKI key: fingerprint of the SPKI
    const spkiParty = `x::${cantonFingerprint(u.spki)}`
    expect(bindsParty(parseLoopPublicKey(u.hex), spkiParty)).toBe('spki')
    expect(bindsParty(parseLoopPublicKey(loopUser().hex), u.party)).toBeNull()
    expect(bindsParty(parseLoopPublicKey(u.hex), 'x::1220abcd')).toBeNull()
    expect(() => parseLoopPublicKey('not a key')).toThrow(LoopKeyError)
    expect(() => parseLoopPublicKey('ab'.repeat(31))).toThrow(LoopKeyError)
  })
})

describe('Loop signature', () => {
  const u = loopUser()
  const key = parseLoopPublicKey(u.hex)
  const message = 'Canton Lending\nSupply 1.0 USDCx'

  it('accepts hex and base64 over UTF-8, then over SHA-256 of the text', async () => {
    expect(verifyLoopSignature(key, message, u.sign(message))).toEqual({
      encoding: 'hex',
      payload: 'utf8',
    })
    expect(verifyLoopSignature(key, message, u.sign(message, 'base64'))?.encoding).toBe('base64')
    const { createHash } = await import('node:crypto')
    const digest = createHash('sha256').update(message).digest()
    expect(verifyLoopSignature(key, message, signWith(u.privateKey, digest))?.payload).toBe(
      'sha256',
    )
  })

  it('refuses another text, another key and garbage', () => {
    expect(verifyLoopSignature(key, `${message}!`, u.sign(message))).toBeNull()
    expect(verifyLoopSignature(key, message, loopUser().sign(message))).toBeNull()
    expect(verifyLoopSignature(key, message, 'zz')).toBeNull()
    expect(verifyLoopSignature(key, message, '00'.repeat(64))).toBeNull()
  })

  it('verifies ECDSA P-256 for an SPKI key (passkey wallets)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const spki = publicKey.export({ format: 'der', type: 'spki' })
    const k = parseLoopPublicKey(spki.toString('base64'))
    expect(k.kind).toBe('ec')
    expect(bindsParty(k, `x::${cantonFingerprint(spki)}`)).toBe('spki')
    const sig = sign('sha256', Buffer.from(message), privateKey).toString('base64')
    expect(verifyLoopSignature(k, message, sig)).toMatchObject({ dsa: 'der' })
  })

  it('takes the signature out of a response object', () => {
    expect(extractSignature('ab')).toBe('ab')
    expect(extractSignature({ signature: 'ab', public_key: 'x' })).toBe('ab')
    expect(extractSignature({ payload: { signature: 'cd' } })).toBe('cd')
    expect(extractSignature({ other: 1 })).toBeNull()
  })
})

const custody = p('Custody')
const dd = { ...d, evm: { custody } }

/** Reader with a Loop directory: the wallet appears after LoopDirectory_Open. */
function loopReader(
  u: ReturnType<typeof loopUser>,
  opts: { open?: boolean; balance?: string; account?: [string, string] },
) {
  const s = snapshot()
  const [principal, collateral] = opts.account ?? ['0', '0']
  const acc = {
    ...account(principal, collateral),
    payload: { ...account(principal, collateral).payload, owner: custody, loopParty: u.party },
  }
  const base = readerWith(s, acc, { [custody]: [holding('c-1', custody, '800', d.usdcx)] })
  const state = { open: opts.open ?? false, nonce: '3', publicKey: u.hex }
  const wallet = () => ({
    contractId: 'loop-wallet-1',
    templateId: 'x:Lending.Loop:LoopWallet',
    createdEventBlob: 'b',
    synchronizerId: 'sync',
    payload: {
      operator: d.operator,
      custody,
      party: u.party,
      publicKey: state.publicKey,
      network: 'canton:devnet',
      nonce: state.nonce,
      balances: [[d.usdcx, opts.balance ?? '500']],
    },
  })
  const reader = {
    ...base,
    loopWallet: async (party: string) => (state.open && party === u.party ? wallet() : null),
    loopDirectory: async () => ({ contractId: 'loop-dir', payload: { custody } }),
    walletBalances: async (who: string) =>
      who === loopSubject(u.party) ? { USDCx: opts.balance ?? '500' } : { USDCx: '0' },
  } as unknown as Reader
  return { reader, state }
}

type Submitted = [
  string[],
  { ExerciseCommand?: Record<string, unknown> }[],
  unknown,
  { commandId?: string },
]

async function appWith(
  u: ReturnType<typeof loopUser>,
  opts: {
    open?: boolean
    balance?: string
    faucet?: boolean
    clock?: { t: number }
    account?: [string, string]
  } = {},
) {
  const clock = opts.clock ?? { t: Date.now() }
  const now = () => clock.t
  const { reader, state } = loopReader(u, opts)
  const submitted: Submitted[] = []
  const ledger = {
    submit: async (
      actAs: string[],
      cmds: Submitted[1],
      dc: unknown,
      _r: unknown,
      o: Submitted[3],
    ) => {
      submitted.push([actAs, cmds, dc, o])
      const ex = cmds[0]?.ExerciseCommand
      if (ex?.choice === 'LoopDirectory_Open') state.open = true
      if ('CreateCommand' in (cmds[0] ?? {}))
        return {
          updateId: 'upd-offer',
          events: [
            {
              CreatedEvent: {
                templateId: 'pkg:Splice.Testing.Tokens.TestTokenV1:TokenTransferOffer',
                contractId: 'offer-1',
              },
            },
          ],
        }
      return { updateId: 'upd-1', events: [] }
    },
  } as unknown as LedgerClient
  const auth = createAuth('y'.repeat(32), now, { sessionTtlMs: 3_600_000 })
  const commands = createCommandBuilder(dd, reader, registry())
  const loop = createLoop(dd, ledger, reader, commands, { now })
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
      loop,
      testFaucet: opts.faucet ?? false,
    }),
  )
  return { app, submitted, state, clock, loop, reader }
}

type App = Awaited<ReturnType<typeof appWith>>['app']
const host = { host: 'lending.test' }

async function challenge(app: App, party: string, publicKey: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/loop/challenge',
    payload: { party, publicKey },
    headers: host,
  })
}

async function signIn(app: App, u: ReturnType<typeof loopUser>, signature?: unknown) {
  const ch = await challenge(app, u.party, u.raw.toString('base64'))
  expect(ch.statusCode).toBe(200)
  const { message } = ch.json() as { message: string }
  const payload = {
    party: u.party,
    publicKey: u.raw.toString('base64'),
    message,
    signature: signature ?? u.sign(message),
  }
  const res = await app.inject({ method: 'POST', url: '/auth/loop/login', payload, headers: host })
  return { res, message, payload }
}

describe('Loop sign-in', () => {
  it('signs in once with a good signature: loop:<party> session, cookie, account opened', async () => {
    const u = loopUser()
    const { app, submitted } = await appWith(u)
    const { res, message, payload } = await signIn(app, u)
    expect(res.statusCode).toBe(200)
    expect(message).toContain(`Public Key: ${u.hex}`)
    expect(message).toContain(u.party)
    expect(res.json().party).toBe(loopSubject(u.party))
    expect(String(res.headers['set-cookie'])).toMatch(/^lending_session=.+HttpOnly/)
    const open = submitted.find((x) => x[1][0]?.ExerciseCommand?.choice === 'LoopDirectory_Open')!
    expect(open[0]).toEqual([d.operator])
    expect(open[1][0]!.ExerciseCommand!.choiceArgument).toEqual({
      party: u.party,
      publicKey: u.hex,
    })
    const s = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: `Bearer ${res.json().token}` },
    })
    expect(s.json().party).toBe(loopSubject(u.party))
    // replay of the same challenge and signature
    const again = await app.inject({
      method: 'POST',
      url: '/auth/loop/login',
      payload,
      headers: host,
    })
    expect(again.statusCode).toBe(401)
    expect(again.json().error).toMatch(/already used/)
  })

  it('two simultaneous logins with one challenge: exactly one session', async () => {
    const u = loopUser()
    const { app } = await appWith(u, { open: true })
    const ch = (await challenge(app, u.party, u.hex)).json() as { message: string }
    const payload = {
      party: u.party,
      publicKey: u.hex,
      message: ch.message,
      signature: u.sign(ch.message),
    }
    const all = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({ method: 'POST', url: '/auth/loop/login', payload, headers: host }),
      ),
    )
    expect(all.filter((r) => r.statusCode === 200)).toHaveLength(1)
  })

  it('accepts the signature inside a response object', async () => {
    const u = loopUser()
    const { app } = await appWith(u)
    const ch = (await challenge(app, u.party, u.hex)).json() as { message: string }
    const res = await app.inject({
      method: 'POST',
      url: '/auth/loop/login',
      payload: {
        party: u.party,
        publicKey: u.hex,
        message: ch.message,
        signature: { signature: u.sign(ch.message, 'base64') },
      },
      headers: host,
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses a bad signature, then still accepts the good one for the same challenge', async () => {
    const u = loopUser()
    const { app } = await appWith(u)
    const { res, payload } = await signIn(app, u, loopUser().sign('anything'))
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('LOOP_SIGNATURE')
    const good = await app.inject({
      method: 'POST',
      url: '/auth/loop/login',
      payload: { ...payload, signature: u.sign(payload.message) },
      headers: host,
    })
    expect(good.statusCode).toBe(200)
  })

  it('refuses a key whose fingerprint is not the party', async () => {
    const u = loopUser()
    const mallory = loopUser('mallory')
    const { app } = await appWith(u)
    const ch = await challenge(app, u.party, mallory.hex)
    expect(ch.statusCode).toBe(401)
    expect(ch.json().code).toBe('LOOP_KEY_MISMATCH')
    // bypassing the challenge: text and signature for one's own key, under another party
    const own = (await challenge(app, mallory.party, mallory.hex)).json() as { message: string }
    const res = await app.inject({
      method: 'POST',
      url: '/auth/loop/login',
      payload: {
        party: u.party,
        publicKey: mallory.hex,
        message: own.message,
        signature: mallory.sign(own.message),
      },
      headers: host,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('LOOP_KEY_MISMATCH')
  })

  it('refuses an expired challenge and a message the server did not issue', async () => {
    const u = loopUser()
    const clock = { t: Date.now() }
    const { app } = await appWith(u, { clock })
    const ch = (await challenge(app, u.party, u.hex)).json() as { message: string }
    const forged = ch.message.replace('Signing is free', 'Signing is cheap')
    const tampered = await app.inject({
      method: 'POST',
      url: '/auth/loop/login',
      payload: { party: u.party, publicKey: u.hex, message: forged, signature: u.sign(forged) },
      headers: host,
    })
    expect(tampered.statusCode).toBe(401)
    expect(tampered.json().error).toMatch(/not issued/)
    clock.t += 5 * 60_000 + 1_000
    const late = await app.inject({
      method: 'POST',
      url: '/auth/loop/login',
      payload: {
        party: u.party,
        publicKey: u.hex,
        message: ch.message,
        signature: u.sign(ch.message),
      },
      headers: host,
    })
    expect(late.statusCode).toBe(401)
    expect(late.json().error).toMatch(/expired/)
  })

  it('/config.loop describes loop.init; without custody Loop is off', async () => {
    const u = loopUser()
    const { app } = await appWith(u)
    const reader = {
      ...loopReader(u, {}).reader,
      roles: async () => ({ ...d, liquidators: [d.liquidator] }),
    } as unknown as Reader
    const off = Fastify()
    await off.register(
      protocolRoutes({
        deployment: d,
        ledger: {} as LedgerClient,
        reader,
        commands: createCommandBuilder(d, reader, registry()),
        auth: createAuth('y'.repeat(32)),
        networkId: null,
        history: () => [],
        loop: createLoop(
          d,
          {} as LedgerClient,
          reader,
          createCommandBuilder(d, reader, registry()),
        ),
      }),
    )
    const cfg = (await app.inject({ method: 'GET', url: '/config' })).json()
    expect(cfg.loop).toEqual({
      enabled: true,
      network: 'devnet',
      appName: 'Canton Lending',
      custody,
    })
    expect((await off.inject({ method: 'GET', url: '/config' })).json().loop.enabled).toBe(false)
    const ch = await off.inject({
      method: 'POST',
      url: '/auth/loop/challenge',
      payload: { party: u.party, publicKey: u.hex },
    })
    expect(ch.statusCode).toBe(404)
  })
})

async function signedIn(u: ReturnType<typeof loopUser>, opts: Parameters<typeof appWith>[1] = {}) {
  const ctx = await appWith(u, opts)
  const { res } = await signIn(ctx.app, u)
  expect(res.statusCode).toBe(200)
  return { ...ctx, headers: { authorization: `Bearer ${res.json().token as string}` } }
}

interface PrepareBody {
  actAs: string[]
  commands: { ExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> } }[]
  disclosedContracts: unknown[]
  loop: { nonce: number; expiresAt: string; party: string }
  message: string
  seal: string
}

describe('Loop operations', () => {
  it('prepares Pool_LoopWalletExecute and submits it from the custody with the signed text', async () => {
    const u = loopUser()
    const { app, submitted, headers } = await signedIn(u)
    const prep = await app.inject({
      method: 'POST',
      url: '/loop/prepare',
      payload: { party: u.party, op: 'supply', amount: '100' },
      headers,
    })
    expect(prep.statusCode).toBe(200)
    const body = prep.json() as PrepareBody
    expect(body.actAs).toEqual([custody])
    const ex = body.commands[0]!.ExerciseCommand
    expect(ex.choice).toBe('Pool_LoopWalletExecute')
    expect(ex.choiceArgument).toMatchObject({
      custody,
      walletCid: 'loop-wallet-1',
      accountCid: 'acc',
      action: { tag: 'EvmSupply', value: { amount: '100' } },
      nonce: '3',
      signedMessage: body.message,
      signature: '',
    })
    expect(body.message).toBe(
      loopMessage({
        network: 'canton:devnet',
        operator: d.operator,
        party: u.party,
        action: { kind: 'supply', amount: '100', full: false },
        debt: 'USDCx',
        nonce: 3,
        expiresAt: body.loop.expiresAt,
      }),
    )
    expect(body.message.split('\n').slice(0, 2)).toEqual(['Canton Lending', 'Supply 100.0 USDCx'])
    const { message, ...sealed } = body
    const signature = u.sign(message)
    const res = await app.inject({
      method: 'POST',
      url: '/loop/submit',
      payload: { ...sealed, signature },
      headers,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ updateId: 'upd-1' })
    const [actAs, cmds, , o] = submitted.at(-1)!
    expect(actAs).toEqual([custody])
    expect(cmds[0]!.ExerciseCommand!.choiceArgument).toMatchObject({
      signedMessage: message,
      signature,
    })
    expect(o.commandId).toMatch(/^loop-[0-9a-f]{40}-3$/)
    // the same seal does not pass a second time
    const replay = await app.inject({
      method: 'POST',
      url: '/loop/submit',
      payload: { ...sealed, signature },
      headers,
    })
    expect(replay.statusCode).toBe(422)
  })

  it('borrow and withdraw are different signed texts and actions (risk 7, review 03.10 item 20)', async () => {
    const u = loopUser()
    // a deposit of 100 to withdraw from, 10 000 CC of collateral to borrow against
    const { app, headers } = await signedIn(u, { account: ['100', '10000'] })
    const prepare = async (op: string) => {
      const r = await app.inject({
        method: 'POST',
        url: '/loop/prepare',
        payload: { party: u.party, op, amount: '50' },
        headers,
      })
      return { status: r.statusCode, body: r.json() as PrepareBody & { error?: string } }
    }
    const withdraw = await prepare('withdraw')
    const borrow = await prepare('borrow')
    for (const [name, r] of [
      ['withdraw', withdraw],
      ['borrow', borrow],
    ] as const)
      expect(r.status, `${name}: ${JSON.stringify(r.body.error)}`).toBe(200)
    const action = (b: PrepareBody) =>
      (b.commands[0]!.ExerciseCommand.choiceArgument as { action: unknown }).action
    expect(action(withdraw.body)).toMatchObject({ tag: 'EvmWithdraw', value: { amount: '50' } })
    expect(action(borrow.body)).toMatchObject({ tag: 'EvmBorrow', value: { amount: '50' } })
    expect(withdraw.body.message.split('\n')[1]).toBe('Withdraw 50.0 USDCx')
    expect(borrow.body.message.split('\n')[1]).toBe('Borrow 50.0 USDCx')
    // the collateral switch does not exist in the Compound V3 model
    const toggle = await app.inject({
      method: 'POST',
      url: '/loop/prepare',
      payload: { party: u.party, op: 'set-collateral-enabled', marketId: 'CC', enabled: false },
      headers,
    })
    expect(toggle.statusCode).toBe(400)
  })

  it('refuses a signature by another key and a tampered command', async () => {
    const u = loopUser()
    const { app, headers } = await signedIn(u)
    const prepare = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/loop/prepare',
          payload: { party: u.party, op: 'supply', amount: '10' },
          headers,
        })
      ).json() as PrepareBody
    const { message, ...sealed } = await prepare()
    const bad = await app.inject({
      method: 'POST',
      url: '/loop/submit',
      payload: { ...sealed, signature: loopUser().sign(message) },
      headers,
    })
    expect(bad.statusCode).toBe(401)
    expect(bad.json().code).toBe('LOOP_SIGNATURE')
    const second = await prepare()
    const tampered = structuredClone(second)
    tampered.commands[0]!.ExerciseCommand.choiceArgument.action = {
      tag: 'EvmSupply',
      value: { amount: '1' },
    }
    const { message: m2, ...t } = tampered
    const res = await app.inject({
      method: 'POST',
      url: '/loop/submit',
      payload: { ...t, signature: u.sign(m2) },
      headers,
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses an operation prepared at another nonce', async () => {
    const u = loopUser()
    const { app, headers, state } = await signedIn(u)
    const { message, ...sealed } = (
      await app.inject({
        method: 'POST',
        url: '/loop/prepare',
        payload: { party: u.party, op: 'supply', amount: '10' },
        headers,
      })
    ).json() as PrepareBody
    state.nonce = '4'
    const res = await app.inject({
      method: 'POST',
      url: '/loop/submit',
      payload: { ...sealed, signature: u.sign(message) },
      headers,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('LOOP_NONCE_MISMATCH')
  })

  it('refuses an expired operation: the seal at the route, the signature term in submit', async () => {
    const u = loopUser()
    const clock = { t: Date.now() }
    const { app, headers, loop } = await signedIn(u, { clock })
    const { message, ...sealed } = (
      await app.inject({
        method: 'POST',
        url: '/loop/prepare',
        payload: { party: u.party, op: 'supply', amount: '10' },
        headers,
      })
    ).json() as PrepareBody
    clock.t += 11 * 60_000
    const late = await app.inject({
      method: 'POST',
      url: '/loop/submit',
      payload: { ...sealed, signature: u.sign(message) },
      headers,
    })
    expect(late.statusCode).toBe(422)
    // Bypassing the seal: submit itself also checks the signature expiry
    const err = await loop
      .submit(sealed as unknown as LoopSealedBody, u.sign(message))
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LoopError)
    expect((err as LoopError).code).toBe('LOOP_SIGNATURE_EXPIRED')
  })

  it('a Loop session acts only for its own Loop account', async () => {
    const u = loopUser()
    const other = loopUser('other')
    const { app, headers } = await signedIn(u)
    const prep = await app.inject({
      method: 'POST',
      url: '/loop/prepare',
      payload: { party: other.party, op: 'supply', amount: '10' },
      headers,
    })
    expect(prep.statusCode).toBe(403)
    // a Loop session is not a session of the Canton party with the same ID
    const cmd = await app.inject({
      method: 'POST',
      url: '/commands/open-account',
      payload: { party: u.party },
      headers,
    })
    expect(cmd.statusCode).toBe(403)
    const w = await app.inject({ method: 'GET', url: `/wallet/${u.party}`, headers })
    expect(w.statusCode).toBe(200)
    expect(w.json()).toEqual({ USDCx: '500' })
    const w2 = await app.inject({ method: 'GET', url: `/wallet/loop:${u.party}`, headers })
    expect(w2.json()).toEqual({ USDCx: '500' })
    const w3 = await app.inject({ method: 'GET', url: `/wallet/${other.party}`, headers })
    expect(w3.statusCode).toBe(403)
  })

  it('faucet: the registry offers to the custody, the custody credits the LoopWallet', async () => {
    const u = loopUser()
    const { app, headers, submitted } = await signedIn(u, { faucet: true })
    const res = await app.inject({
      method: 'POST',
      url: '/faucet',
      payload: { symbol: 'USDCx' },
      headers,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ offerCid: 'offer-1', received: true, symbol: 'USDCx' })
    const offer = submitted.find((x) => 'CreateCommand' in (x[1][0] ?? {}))!
    const create = (
      offer[1][0] as { CreateCommand: { createArguments: { transfer: { receiver: string } } } }
    ).CreateCommand
    expect(create.createArguments.transfer.receiver).toBe(custody)
    const [actAs, cmds, , o] = submitted.at(-1)!
    expect(actAs).toEqual([custody])
    expect(cmds[0]!.ExerciseCommand).toMatchObject({
      contractId: 'loop-wallet-1',
      choice: 'LoopWallet_Receive',
      choiceArgument: { instructionCid: 'offer-1' },
    })
    expect(o.commandId).toMatch(/^loop-receive-/)
  })
})
