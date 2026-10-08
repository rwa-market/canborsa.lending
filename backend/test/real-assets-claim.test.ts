/**
 * Seam 2: xReserve deposit claim. Ethereum RPC, ledger and DA Utilities are stubs;
 * the database is in-memory SQLite. Every refusal leaves no USDCx minted and no tx taken.
 */
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import { encodeFunctionData, type Hex, keccak256, stringToBytes, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { createXreserveClaims } from '../src/assets/claims.ts'
import { BRIDGE_TEMPLATES, REAL_PROFILES } from '../src/assets/profiles.ts'
import { createRealAssetsStore } from '../src/assets/store.ts'
import type { BurnMintFactory } from '../src/assets/utilities.ts'
import {
  ClaimError,
  ERC20_TRANSFER_TOPIC,
  type EthRpc,
  XRESERVE_ABI,
} from '../src/assets/xreserve.ts'
import { createAuth } from '../src/auth.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { protocolRoutes } from '../src/routes/protocol.ts'
import { createMetrics } from '../src/metrics.ts'
import { TEMPLATES } from '../src/ledger/ids.ts'
import { LedgerError } from '../src/ledger/client.ts'
import type { Reader } from '../src/protocol/reader.ts'
import { d, holding, p, readerWith, snapshot } from './fixtures.ts'

const profile = REAL_PROFILES.testnet
const x = profile.xreserve
const custody = p('Custody')
const ADDRESS = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23'
const OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const TX = `0x${'ab'.repeat(32)}`
const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`

function depositTx(
  o: {
    from?: string
    to?: string
    value?: bigint
    recipient?: string
    domain?: number
    token?: string
    logValue?: bigint
    status?: string
    block?: bigint
  } = {},
) {
  const value = o.value ?? 25_500_000n
  const recipient = o.recipient ?? custody
  const input = encodeFunctionData({
    abi: XRESERVE_ABI,
    functionName: 'depositToRemote',
    args: [
      value,
      o.domain ?? 10001,
      keccak256(stringToBytes(recipient)),
      (o.token ?? x.usdc) as Hex,
      0n,
      toHex(stringToBytes(recipient)),
    ],
  })
  const from = o.from ?? ADDRESS
  return {
    tx: { hash: TX, from, to: o.to ?? x.contract, input, blockNumber: '0x64' },
    receipt: {
      status: o.status ?? '0x1',
      blockNumber: `0x${(o.block ?? 100n).toString(16)}`,
      logs: [
        {
          address: x.usdc,
          topics: [ERC20_TRANSFER_TOPIC, pad(from), pad(x.contract)],
          data: pad(`0x${(o.logValue ?? value).toString(16)}`),
        },
      ],
    },
  }
}

function rpcOf(
  t: ReturnType<typeof depositTx> | null,
  opts: { chainId?: number; head?: bigint } = {},
): EthRpc {
  return {
    chainId: async () => opts.chainId ?? x.chainId,
    blockNumber: async () => opts.head ?? 200n,
    transaction: async (h) => (t && h === TX ? t.tx : null),
    receipt: async (h) => (t && h === TX ? t.receipt : null),
  }
}

const attestation = (cid: string, amount: string, extra: Record<string, unknown> = {}) => ({
  contractId: cid,
  templateId: 'pkg:Utility.Bridge.V0.Attestation.Deposit:DepositAttestation',
  createdEventBlob: 'b',
  synchronizerId: 's',
  payload: { amount, ...extra },
})

interface LedgerState {
  attestations: ReturnType<typeof attestation>[]
  refs: string[]
  /** CreditDeposit refusal or a network failure at the step */
  creditError?: unknown
  mintError?: unknown
}

function ledgerWith(st: LedgerState, submitted: unknown[][]) {
  const row = (contractId: string, payload: unknown) => ({
    contractId,
    templateId: 't',
    createdEventBlob: 'b',
    synchronizerId: 's',
    payload,
  })
  return {
    query: async (_party: string, f: { templateId?: string }) => {
      if (f.templateId === BRIDGE_TEMPLATES.depositAttestation) return st.attestations
      if (f.templateId === BRIDGE_TEMPLATES.userAgreement)
        return [row('agreement-1', { user: custody })]
      if (f.templateId === TEMPLATES.depositRegistry)
        return [
          row('registry-1', {
            operator: d.operator,
            custody,
            refs: { map: st.refs.map((r) => [r, {}]) },
          }),
        ]
      return []
    },
    submit: async (
      actAs: string[],
      cmds: { ExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> } }[],
      disclosed: unknown,
      _r: unknown,
      o: unknown,
    ) => {
      const ex = cmds[0]!.ExerciseCommand
      if (ex.choice === 'BridgeUserAgreement_Mint') {
        if (st.mintError) throw st.mintError
        st.attestations = st.attestations.filter(
          (a) => a.contractId !== ex.choiceArgument.depositAttestationCid,
        )
      }
      if (ex.choice === 'EvmWallet_CreditDeposit') {
        if (st.creditError) throw st.creditError
        st.refs.push(ex.choiceArgument.depositRef as string)
      }
      submitted.push([actAs, cmds, disclosed, o])
      return { updateId: `upd-${submitted.length}`, events: [] }
    },
  } as unknown as LedgerClient
}

const minted = [holding('m-1', custody, '25.5', profile.instruments.usdcx)]
const claimReader = {
  ...readerWith(snapshot(), null),
  holdings: async () => minted,
  evmWallet: async (a: string) => (a === ADDRESS ? { contractId: 'wallet-1' } : null),
} as unknown as Reader

const burnMint: BurnMintFactory = {
  context: async () => ({
    factoryCid: 'factory-1',
    contextContractIds: {
      instrumentConfigurationCid: 'ic',
      appRewardConfigurationCid: 'arc',
      featuredAppRightCid: 'far',
    },
    disclosed: [{ templateId: 't', contractId: 'ic', createdEventBlob: 'b', synchronizerId: 's' }],
  }),
}

function claimsWith(
  rpc: EthRpc,
  attestations = [attestation('att-1', '25.5')],
  over: Partial<LedgerState> = {},
) {
  const submitted: unknown[][] = []
  const state: LedgerState = { attestations, refs: [], ...over }
  const clock = { t: 1_800_000_000_000 }
  const store = createRealAssetsStore(new Database(':memory:'), () => clock.t)
  const metrics = createMetrics()
  const opened: string[] = []
  const claims = createXreserveClaims({
    ledger: ledgerWith(state, submitted),
    reader: claimReader,
    ensureAccount: async (a) => void opened.push(a),
    operator: d.operator,
    store,
    rpc,
    burnMint,
    custody,
    usdcx: profile.instruments.usdcx,
    xreserve: x,
    minConfirmations: 12,
    metrics,
  })
  return { claims, store, submitted, metrics, state, opened, clock }
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p
  } catch (err) {
    if (err instanceof ClaimError) return err.code
    throw err
  }
  return 'OK'
}

describe('POST /evm/claim-deposit verification', () => {
  it('happy path: verifies the tx, mints to the custody party, credits the wallet once', async () => {
    const { claims, store, submitted, metrics, state } = claimsWith(rpcOf(depositTx()))
    const r = await claims.claim(ADDRESS, TX)
    expect(r).toEqual({ txHash: TX, amount: '25.5', status: 'credited' })
    expect(submitted).toHaveLength(2)
    const [actAs, cmds, disclosed, opts] = submitted[0] as [
      string[],
      {
        ExerciseCommand: {
          choice: string
          contractId: string
          choiceArgument: Record<string, unknown>
        }
      }[],
      unknown[],
      { commandId: string },
    ]
    expect(actAs).toEqual([custody])
    expect(cmds[0]!.ExerciseCommand.choice).toBe('BridgeUserAgreement_Mint')
    expect(cmds[0]!.ExerciseCommand.contractId).toBe('agreement-1')
    expect(cmds[0]!.ExerciseCommand.choiceArgument).toEqual({
      depositAttestationCid: 'att-1',
      factoryCid: 'factory-1',
      contextContractIds: {
        instrumentConfigurationCid: 'ic',
        appRewardConfigurationCid: 'arc',
        featuredAppRightCid: 'far',
      },
    })
    expect(disclosed).toHaveLength(1)
    expect(opts.commandId).toMatch(/^xreserve-mint-[0-9a-f]{40}$/)
    const [credActAs, credCmds, credDisclosed, credOpts] = submitted[1] as (typeof submitted)[0] &
      [
        string[],
        { ExerciseCommand: { choice: string; contractId: string; choiceArgument: unknown } }[],
        { contractId: string }[],
        { commandId: string },
      ]
    expect(credActAs).toEqual([custody])
    expect(credCmds[0]!.ExerciseCommand).toEqual({
      templateId: TEMPLATES.evmWallet,
      contractId: 'wallet-1',
      choice: 'EvmWallet_CreditDeposit',
      choiceArgument: {
        configCid: 'cfg',
        registryCid: 'registry-1',
        holdingCids: ['m-1'],
        instrumentId: { admin: profile.instruments.usdcx.admin, id: 'USDCx' },
        amount: '25.5',
        depositRef: TX,
      },
    })
    // the operator config is not visible to the custodian: it is disclosed in the command
    expect(credDisclosed.map((c) => c.contractId)).toEqual(['cfg'])
    expect(credOpts.commandId).toMatch(/^xreserve-credit-[0-9a-f]{40}$/)
    expect(state.refs).toEqual([TX])
    expect(store.claim(TX)).toMatchObject({
      address: ADDRESS,
      status: 'credited',
      attestation_cid: 'att-1',
    })
    expect(store.quarantineOpen()).toEqual([])
    expect(metrics.get('xreserve_claims_total', { outcome: 'minted' })).toBe(1)
    expect(metrics.get('xreserve_claims_total', { outcome: 'credited' })).toBe(1)
  })

  it('a failed credit after the mint resumes on the next claim without a second mint', async () => {
    const c = claimsWith(rpcOf(depositTx()), undefined, { creditError: new Error('fetch failed') })
    expect(await codeOf(c.claims.claim(ADDRESS, TX))).toBe('LEDGER_BUSY')
    expect(c.store.claim(TX)?.status).toBe('minted')
    // another address cannot intercept a minted deposit
    expect(await codeOf(c.claims.claim(OTHER, TX))).toBe('ALREADY_CLAIMED')
    c.state.creditError = undefined
    expect((await c.claims.claim(ADDRESS, TX)).status).toBe('credited')
    const choices = c.submitted.map(
      (x) => (x[1] as { ExerciseCommand: { choice: string } }[])[0]!.ExerciseCommand.choice,
    )
    expect(choices).toEqual(['BridgeUserAgreement_Mint', 'EvmWallet_CreditDeposit'])
  })

  it('a contract refusal of the credit goes to quarantine; a ref already in the registry is credited', async () => {
    const c = claimsWith(rpcOf(depositTx()), undefined, {
      creditError: new LedgerError('x', 400, null, 'holdings below the credited amount'),
    })
    await expect(c.claims.claim(ADDRESS, TX)).rejects.toThrow()
    expect(c.store.quarantineOpen()).toEqual([
      expect.objectContaining({
        id: `xreserve:${TX}`,
        cause: 'minted-not-credited',
        sender: ADDRESS,
        detail: 'holdings below the credited amount',
      }),
    ])
    // the ledger already credited it (DepositRegistry contains the hash): no second command
    c.state.creditError = undefined
    c.state.refs.push(TX)
    expect((await c.claims.claim(ADDRESS, TX)).status).toBe('credited')
    expect(c.store.quarantineOpen()).toEqual([])
    expect(c.submitted).toHaveLength(1)
  })

  it('a mint whose outcome was lost: the archived own attestation means minted, then credit', async () => {
    const c = claimsWith(rpcOf(depositTx()), undefined, { mintError: new Error('fetch failed') })
    expect(await codeOf(c.claims.claim(ADDRESS, TX))).toBe('LEDGER_BUSY')
    expect(c.store.claim(TX)).toMatchObject({ status: 'verifying', attestation_cid: 'att-1' })
    // until the claim lock expires, the retry waits
    expect(await codeOf(c.claims.claim(ADDRESS, TX))).toBe('CLAIM_IN_PROGRESS')
    // the mint actually went through: the attestation is gone; the claim lock expired
    c.state.attestations = []
    c.state.mintError = undefined
    c.clock.t += 61_000
    expect((await c.claims.claim(ADDRESS, TX)).status).toBe('credited')
    const choices = c.submitted.map(
      (x) => (x[1] as { ExerciseCommand: { choice: string } }[])[0]!.ExerciseCommand.choice,
    )
    expect(choices).toEqual(['EvmWallet_CreditDeposit'])
  })

  it('replay of the same tx is refused and mints nothing more', async () => {
    const { claims, submitted } = claimsWith(rpcOf(depositTx()))
    await claims.claim(ADDRESS, TX)
    expect(await codeOf(claims.claim(ADDRESS, TX))).toBe('ALREADY_CLAIMED')
    expect(await codeOf(claims.claim(OTHER, TX))).toBe('ALREADY_CLAIMED')
    expect(submitted).toHaveLength(2)
  })

  it('wrong sender: another session cannot claim the tx, and does not block the real sender', async () => {
    const { claims, submitted } = claimsWith(rpcOf(depositTx()))
    expect(await codeOf(claims.claim(OTHER, TX))).toBe('WRONG_SENDER')
    expect(submitted).toHaveLength(0)
    expect((await claims.claim(ADDRESS, TX)).status).toBe('credited')
  })

  it('wrong recipient: the deposit goes to another Canton party', async () => {
    const { claims, submitted } = claimsWith(rpcOf(depositTx({ recipient: p('Mallory') })))
    expect(await codeOf(claims.claim(ADDRESS, TX))).toBe('WRONG_RECIPIENT')
    expect(submitted).toHaveLength(0)
  })

  it('amount mismatch: no attestation of this amount, or one for this tx with another amount', async () => {
    const none = claimsWith(rpcOf(depositTx()), [attestation('att-1', '30')])
    expect(await codeOf(none.claims.claim(ADDRESS, TX))).toBe('NOT_ATTESTED')
    const named = claimsWith(rpcOf(depositTx()), [
      attestation('att-1', '25.5'),
      attestation('att-2', '99', { sourceTxHash: TX }),
    ])
    expect(await codeOf(named.claims.claim(ADDRESS, TX))).toBe('AMOUNT_MISMATCH')
    // a USDC Transfer log with a different amount than in calldata
    const forged = claimsWith(rpcOf(depositTx({ logValue: 1n })))
    expect(await codeOf(forged.claims.claim(ADDRESS, TX))).toBe('NO_DEPOSIT_LOG')
    expect([...none.submitted, ...named.submitted, ...forged.submitted]).toHaveLength(0)
    // a refusal does not take the tx: when the attestation arrives, the claim goes through
    expect(none.store.claim(TX)).toBeNull()
  })

  it('an attestation is used once: a second deposit of the same amount waits for its own', async () => {
    const att = [attestation('att-1', '25.5')]
    const { claims, store } = claimsWith(rpcOf(depositTx()), att)
    await claims.claim(ADDRESS, TX)
    expect(store.attachAttestation(`0x${'cd'.repeat(32)}`, 'att-1', '25.5')).toBe(false)
  })

  it('unknown tx, pending tx, failed tx, wrong chain, wrong contract, wrong domain, wrong token', async () => {
    const cases: [EthRpc, string][] = [
      [rpcOf(null), 'TX_NOT_FOUND'],
      [rpcOf(depositTx({ block: 195n })), 'TX_PENDING'],
      [rpcOf(depositTx({ status: '0x0' })), 'TX_FAILED'],
      [rpcOf(depositTx(), { chainId: 1 }), 'WRONG_CHAIN'],
      [rpcOf(depositTx({ to: OTHER })), 'NOT_XRESERVE'],
      [rpcOf(depositTx({ domain: 0 })), 'WRONG_DOMAIN'],
      [rpcOf(depositTx({ token: OTHER })), 'WRONG_TOKEN'],
    ]
    for (const [rpc, code] of cases) {
      const { claims, submitted } = claimsWith(rpc)
      expect(await codeOf(claims.claim(ADDRESS, TX)), code).toBe(code)
      expect(submitted).toHaveLength(0)
    }
  })

  it('an attested amount below the deposit is not accepted when maxFee is 0', async () => {
    const t = depositTx({ value: 10_000_000n })
    // maxFee = 0 in calldata: 9.99 does not pass
    const { claims } = claimsWith(rpcOf(t), [attestation('att-1', '9.99')])
    expect(await codeOf(claims.claim(ADDRESS, TX))).toBe('NOT_ATTESTED')
  })
})

describe('claim route', () => {
  async function appWith(claims?: ReturnType<typeof claimsWith>['claims']) {
    const auth = createAuth('y'.repeat(32), Date.now, { sessionTtlMs: 600_000 })
    const evm = { enabled: true, custody, loginMessage: () => '' } as never
    const app = Fastify()
    await app.register(
      protocolRoutes({
        deployment: { ...d, evm: { custody } },
        ledger: {} as LedgerClient,
        reader: readerWith(snapshot(), null),
        commands: {} as never,
        auth,
        networkId: 'canton:testnet',
        history: () => [],
        evm,
        ...(claims
          ? {
              realAssets: {
                info: {
                  enabled: true,
                  profile: 'real',
                  instruments: profile.instruments,
                  custody,
                  depositReasonPrefix: 'lending:evm:',
                  xreserve: null,
                },
                claims,
              },
            }
          : {}),
      }),
    )
    return { app, token: auth.issue(ADDRESS), partyToken: auth.issue(d.alice!) }
  }

  it('claims with the EVM session: 200 credited, then 409 on replay', async () => {
    const { app, token } = await appWith(claimsWith(rpcOf(depositTx())).claims)
    const headers = { authorization: `Bearer ${token}` }
    const r = await app.inject({
      method: 'POST',
      url: '/evm/claim-deposit',
      payload: { txHash: TX.toUpperCase().replace('0X', '0x') },
      headers,
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ txHash: TX, amount: '25.5', status: 'credited' })
    const again = await app.inject({
      method: 'POST',
      url: '/evm/claim-deposit',
      payload: { txHash: TX },
      headers,
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('ALREADY_CLAIMED')
  })

  it('needs an EVM session and a tx hash; absent on DevNet', async () => {
    const { app, partyToken } = await appWith(claimsWith(rpcOf(depositTx())).claims)
    const anon = await app.inject({
      method: 'POST',
      url: '/evm/claim-deposit',
      payload: { txHash: TX },
    })
    expect(anon.statusCode).toBe(401)
    const party = await app.inject({
      method: 'POST',
      url: '/evm/claim-deposit',
      payload: { txHash: TX },
      headers: { authorization: `Bearer ${partyToken}` },
    })
    expect(party.statusCode).toBe(401)
    const { app: devnet, token } = await appWith()
    const off = await devnet.inject({
      method: 'POST',
      url: '/evm/claim-deposit',
      payload: { txHash: TX },
      headers: { authorization: `Bearer ${token}` },
    })
    expect(off.statusCode).toBe(404)
  })

  it('rejections map to their HTTP status and code', async () => {
    const { app, token } = await appWith(claimsWith(rpcOf(depositTx({ from: OTHER }))).claims)
    const r = await app.inject({
      method: 'POST',
      url: '/evm/claim-deposit',
      payload: { txHash: TX },
      headers: { authorization: `Bearer ${token}` },
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('WRONG_SENDER')
  })
})
