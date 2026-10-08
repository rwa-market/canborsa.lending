/**
 * Seam 2: keyed price adapters, registry accept context, custodian onboarding.
 */
import { createHmac } from 'node:crypto'
import { encodeAbiParameters, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { BRIDGE_TEMPLATES, PREAPPROVAL_TEMPLATES, REAL_PROFILES } from '../src/assets/profiles.ts'
import {
  setupCcPreapproval,
  setupDepositRegistry,
  setupXreserveOnboarding,
} from '../src/assets/setup.ts'
import { TEMPLATES } from '../src/ledger/ids.ts'
import { httpBurnMintFactory } from '../src/assets/utilities.ts'
import {
  chainlink,
  chainlinkHeaders,
  decodeChainlinkReport,
  kaiko,
  redstone,
} from '../src/bots/price-adapters.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { httpRegistry } from '../src/protocol/registry.ts'
import { p } from './fixtures.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function v3Report(price: bigint, observed: number): Hex {
  const blob = encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint32' },
      { type: 'uint32' },
      { type: 'uint192' },
      { type: 'uint192' },
      { type: 'uint32' },
      { type: 'int192' },
      { type: 'int192' },
      { type: 'int192' },
    ],
    [`0x${'11'.repeat(32)}`, observed, observed, 1n, 1n, observed + 60, price, price, price],
  )
  const z = `0x${'00'.repeat(32)}` as Hex
  return encodeAbiParameters(
    [
      { type: 'bytes32[3]' },
      { type: 'bytes' },
      { type: 'bytes32[]' },
      { type: 'bytes32[]' },
      { type: 'bytes32' },
    ],
    [[z, z, z], blob, [], [], z],
  )
}

describe('keyed price adapters', () => {
  it('chainlink: decodes a V3 report price with 18 decimals, signs the request with HMAC', async () => {
    expect(decodeChainlinkReport(v3Report(97_123_450_000_000_000_000_000n, 1_790_000_000))).toEqual(
      {
        price: '97123.45',
        observedAt: new Date(1_790_000_000_000).toISOString(),
      },
    )
    const h = chainlinkHeaders('GET', '/api/v1/reports/latest?feedID=0xab', '', 'key', 'secret', 42)
    const bodyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    expect(h).toEqual({
      authorization: 'key',
      'x-authorization-timestamp': '42',
      'x-authorization-signature-sha256': createHmac('sha256', 'secret')
        .update(`GET /api/v1/reports/latest?feedID=0xab ${bodyHash} key 42`)
        .digest('hex'),
    })
    const feed = `0x${'ab'.repeat(32)}`
    const calls: [string, Record<string, string>][] = []
    const src = chainlink(
      { cbtc: feed },
      {
        url: 'https://streams.example',
        apiKey: 'key',
        secret: 'secret',
        now: () => 42,
        fetchImpl: (async (url: string, init: { headers: Record<string, string> }) => {
          calls.push([url, init.headers])
          return json({ report: { fullReport: v3Report(10n ** 18n, 1_790_000_000) } })
        }) as unknown as typeof fetch,
      },
    )
    expect(await src.fetch(['cbtc', 'cc'])).toEqual({
      cbtc: { price: '1', observedAt: new Date(1_790_000_000_000).toISOString() },
    })
    expect(calls[0]![0]).toBe(`https://streams.example/api/v1/reports/latest?feedID=${feed}`)
    // the key goes only in headers, not in the URL
    expect(calls[0]![0]).not.toContain('key')
  })

  it('redstone and kaiko: price and time from the response, key in a header', async () => {
    const seen: [string, Record<string, string>][] = []
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push([url, init.headers])
      return url.includes('redstone')
        ? json({ BTC: { value: 97000.5, timestamp: 1_790_000_000_000 } })
        : json({ data: [{ price: '0.1523', timestamp: 1_790_000_000_000 }] })
    }) as unknown as typeof fetch
    const rs = redstone(
      { cbtc: 'BTC' },
      { url: 'https://api.redstone.example', apiKey: 'rk', fetchImpl },
    )
    expect(await rs.fetch(['cbtc'])).toEqual({
      cbtc: { price: '97000.5', observedAt: new Date(1_790_000_000_000).toISOString() },
    })
    const kk = kaiko({ cc: 'cc' }, { url: 'https://kaiko.example', apiKey: 'kk', fetchImpl })
    expect(await kk.fetch(['cc'])).toEqual({
      cc: { price: '0.1523', observedAt: new Date(1_790_000_000_000).toISOString() },
    })
    expect(seen.map(([, h]) => h['x-api-key'])).toEqual(['rk', 'kk'])
  })
})

describe('registry accept context and DA Utilities factory', () => {
  it('fetches the accept choice context of an incoming instruction', async () => {
    const calls: string[] = []
    const reg = httpRegistry({
      endpoints: { cbtc: { url: 'https://reg.example/' } },
      slotOf: () => 'cbtc',
      fetchImpl: (async (url: string) => {
        calls.push(url)
        return json({
          choiceContextData: { values: { round: { tag: 'AV_Int', value: '1' } } },
          disclosedContracts: [
            {
              templateId: 't',
              contractId: 'c',
              createdEventBlob: 'b',
              synchronizerId: 's',
              debug: 1,
            },
          ],
        })
      }) as unknown as typeof fetch,
    })
    const r = await reg.acceptContext!({ admin: p('Cbtc'), id: 'CBTC' }, 'ti/1')
    expect(calls).toEqual([
      'https://reg.example/registry/transfer-instruction/v1/ti%2F1/choice-contexts/accept',
    ])
    expect(r).toEqual({
      extraArgs: {
        context: { values: { round: { tag: 'AV_Int', value: '1' } } },
        meta: { values: {} },
      },
      disclosed: [{ templateId: 't', contractId: 'c', createdEventBlob: 'b', synchronizerId: 's' }],
    })
  })

  it('fetches the withdraw choice context of an outgoing instruction', async () => {
    const calls: string[] = []
    const reg = httpRegistry({
      endpoints: { cc: { url: 'https://scan.example' } },
      slotOf: () => 'cc',
      fetchImpl: (async (url: string) => {
        calls.push(url)
        return json({ choiceContextData: { values: {} }, disclosedContracts: [] })
      }) as unknown as typeof fetch,
    })
    const r = await reg.withdrawContext!({ admin: p('Dso'), id: 'Amulet' }, 'ti-9')
    expect(calls).toEqual([
      'https://scan.example/registry/transfer-instruction/v1/ti-9/choice-contexts/withdraw',
    ])
    expect(r).toEqual({
      extraArgs: { context: { values: {} }, meta: { values: {} } },
      disclosed: [],
    })
  })

  it('reads factoryCid and contextContractIds from burn-mint-factory', async () => {
    const f = httpBurnMintFactory({
      backendUrl: 'https://da.example',
      fetchImpl: (async () =>
        json({
          factoryId: 'factory-1',
          choiceContext: {
            choiceContextData: {
              values: {
                'utility.digitalasset.com/instrument-configuration': { value: 'ic' },
                'utility.digitalasset.com/app-reward-configuration': { value: 'arc' },
                'utility.digitalasset.com/featured-app-right': { value: 'far' },
              },
            },
            disclosedContracts: [],
          },
        })) as unknown as typeof fetch,
    })
    expect(await f.context({ admin: p('U'), id: 'USDCx' }, [], [])).toEqual({
      factoryCid: 'factory-1',
      contextContractIds: {
        instrumentConfigurationCid: 'ic',
        appRewardConfigurationCid: 'arc',
        featuredAppRightCid: 'far',
      },
      disclosed: [],
    })
    const broken = httpBurnMintFactory({
      backendUrl: 'https://da.example',
      fetchImpl: (async () => json({ factoryId: 'f' })) as unknown as typeof fetch,
    })
    await expect(broken.context({ admin: p('U'), id: 'USDCx' }, [], [])).rejects.toThrow(
      /instrument-configuration/,
    )
  })
})

describe('custody setup scripts', () => {
  const profile = REAL_PROFILES.testnet
  const custody = p('Custody')
  function ledgerWith(existing: Record<string, unknown[]>, created: unknown[]) {
    return {
      query: async (_p: string, f: { templateId: string }) => existing[f.templateId] ?? [],
      submit: async (_a: string[], cmds: unknown[]) => {
        created.push(cmds[0])
        return { updateId: 'u', events: [] }
      },
    } as unknown as LedgerClient
  }

  it('xreserve: creates BridgeUserAgreementRequest with the network operators once', async () => {
    const created: unknown[] = []
    const r = await setupXreserveOnboarding(ledgerWith({}, created), profile, custody)
    expect(r.state).toBe('requested')
    expect(created).toEqual([
      {
        CreateCommand: {
          templateId: BRIDGE_TEMPLATES.userAgreementRequest,
          createArguments: {
            crossChainRepresentative: profile.instruments.usdcx.admin,
            operator: profile.bridge.utilityOperator,
            bridgeOperator: profile.bridge.bridgeOperator,
            user: custody,
            instrumentId: profile.instruments.usdcx,
            preApproval: false,
          },
        },
      },
    ])
    const done = await setupXreserveOnboarding(
      ledgerWith(
        { [BRIDGE_TEMPLATES.userAgreement]: [{ contractId: 'a', payload: { user: custody } }] },
        created,
      ),
      profile,
      custody,
    )
    expect(done).toEqual({ state: 'exists', contractId: 'a' })
    expect(created).toHaveLength(1)
  })

  it('cc: needs a provider, proposes the preapproval with the DSO, then waits', async () => {
    const created: unknown[] = []
    await expect(
      setupCcPreapproval(ledgerWith({}, created), profile, custody, undefined),
    ).rejects.toThrow(/CC_PREAPPROVAL_PROVIDER/)
    await setupCcPreapproval(ledgerWith({}, created), profile, custody, p('Validator'))
    expect(created[0]).toEqual({
      CreateCommand: {
        templateId: PREAPPROVAL_TEMPLATES.proposal,
        createArguments: {
          receiver: custody,
          provider: p('Validator'),
          expectedDso: profile.instruments.cc.admin,
        },
      },
    })
    const pending = await setupCcPreapproval(
      ledgerWith(
        {
          [PREAPPROVAL_TEMPLATES.proposal]: [{ contractId: 'pp', payload: { receiver: custody } }],
        },
        created,
      ),
      profile,
      custody,
      p('Validator'),
    )
    expect(pending).toEqual({ state: 'pending', contractId: 'pp' })
  })

  it('deposit registry: created once by the operator and custody together', async () => {
    const created: unknown[] = []
    const actAs: string[][] = []
    const ledger = {
      query: async () => [],
      submit: async (a: string[], cmds: unknown[]) => {
        actAs.push(a)
        created.push(cmds[0])
        return { updateId: 'u', events: [] }
      },
    } as unknown as LedgerClient
    await setupDepositRegistry(ledger, p('Operator'), custody)
    expect(actAs).toEqual([[p('Operator'), custody]])
    expect(created).toEqual([
      {
        CreateCommand: {
          templateId: TEMPLATES.depositRegistry,
          createArguments: { operator: p('Operator'), custody, refs: { map: [] } },
        },
      },
    ])
    const exists = await setupDepositRegistry(
      ledgerWith(
        {
          [TEMPLATES.depositRegistry]: [
            { contractId: 'r', payload: { operator: p('Operator'), custody } },
          ],
        },
        created,
      ),
      p('Operator'),
      custody,
    )
    expect(exists).toEqual({ state: 'exists', contractId: 'r' })
  })
})
