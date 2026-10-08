import { describe, expect, it } from 'vitest'
import { createRegistry, httpRegistry, RegistryError } from '../src/protocol/registry.ts'
import type { LedgerClient } from '../src/ledger/client.ts'

const amulet = { admin: 'DSO::1220dso', id: 'Amulet' }
const disclosed = {
  templateId: 'splice-amulet:Splice.AmuletRules:AmuletRules',
  contractId: 'rules-1',
  createdEventBlob: 'blob',
  synchronizerId: 'global-domain::1220',
  debugPackageName: 'splice-amulet',
}

function registry(
  respond: (body: unknown) => Response,
  opts: { auth?: 'ledger'; now?: () => number } = {},
) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ url, body, auth: (init.headers as Record<string, string>).authorization ?? null })
    return respond(body)
  }) as unknown as typeof fetch
  const r = httpRegistry({
    endpoints: {
      cc: {
        url: 'https://validator.example/api/validator/v0/scan-proxy/',
        auth: opts.auth ?? 'none',
      },
    },
    slotOf: (i) => (i.id === 'Amulet' ? 'cc' : undefined),
    authHeader: async () => 'Bearer validator-token',
    fetchImpl,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { r, calls }
}
const ok = (factoryId = 'factory-1') =>
  new Response(
    JSON.stringify({
      factoryId,
      transferKind: 'direct',
      choiceContext: {
        choiceContextData: {
          values: { 'amulet-rules': { tag: 'AV_ContractId', value: 'rules-1' } },
        },
        disclosedContracts: [disclosed],
      },
    }),
  )

describe('B-2, A-10: Token Standard registry over HTTP', () => {
  it('returns the trusted factory, its choice context and disclosed contracts', async () => {
    const { r, calls } = registry(() => ok(), { auth: 'ledger' })
    const f = await r.transferFactory(amulet, 'factory-1', {
      sender: 'alice::1',
      receiver: 'op::1',
      amount: '10.5',
      inputHoldingCids: ['h1'],
    })
    expect(calls[0]!.url).toBe(
      'https://validator.example/api/validator/v0/scan-proxy/registry/transfer-instruction/v1/transfer-factory',
    )
    expect(calls[0]!.auth).toBe('Bearer validator-token')
    expect(calls[0]!.body).toMatchObject({
      choiceArguments: {
        expectedAdmin: amulet.admin,
        transfer: {
          sender: 'alice::1',
          receiver: 'op::1',
          amount: '10.5',
          instrumentId: amulet,
          inputHoldingCids: ['h1'],
        },
      },
      excludeDebugFields: true,
    })
    expect(f.factoryCid).toBe('factory-1')
    expect(f.transferExtraArgs.context.values).toHaveProperty('amulet-rules')
    expect(f.acceptExtraArgs.context).toEqual(f.transferExtraArgs.context)
    // registry debug fields do not go into the disclosure
    expect(f.disclosed).toEqual([
      {
        templateId: disclosed.templateId,
        contractId: 'rules-1',
        createdEventBlob: 'blob',
        synchronizerId: 'global-domain::1220',
      },
    ])
  })

  it('refuses a factory that is not the one in ProtocolConfig', async () => {
    const { r } = registry(() => ok('evil-factory'))
    await expect(r.transferFactory(amulet, 'factory-1')).rejects.toThrow(
      /untrusted transfer factory/,
    )
  })

  it('refuses incomplete disclosed contracts, HTTP errors and garbage', async () => {
    const broken = registry(
      () =>
        new Response(
          JSON.stringify({
            factoryId: 'factory-1',
            choiceContext: { disclosedContracts: [{ contractId: 'x' }] },
          }),
        ),
    )
    await expect(broken.r.transferFactory(amulet, 'factory-1')).rejects.toThrow(/incomplete/)
    const down = registry(() => new Response('oops', { status: 502 }))
    await expect(down.r.transferFactory(amulet, 'factory-1')).rejects.toBeInstanceOf(RegistryError)
    const html = registry(() => new Response('<html>'))
    await expect(html.r.transferFactory(amulet, 'factory-1')).rejects.toThrow(/not JSON/)
  })

  it('refuses an instrument without a registry URL', async () => {
    const { r } = registry(() => ok())
    await expect(r.transferFactory({ admin: 'x', id: 'USDCx' }, 'f')).rejects.toThrow(
      /no registry URL/,
    )
  })

  it('caches the context for seconds, per sender and receiver', async () => {
    let t = 0
    const { r, calls } = registry(() => ok(), { now: () => t })
    const intent = { sender: 'a', receiver: 'op', amount: '1' }
    await r.transferFactory(amulet, 'factory-1', intent)
    await r.transferFactory(amulet, 'factory-1', { ...intent, amount: '2' })
    expect(calls).toHaveLength(1)
    await r.transferFactory(amulet, 'factory-1', { ...intent, receiver: 'bob' })
    expect(calls).toHaveLength(2)
    t += 6_000
    await r.transferFactory(amulet, 'factory-1', intent)
    expect(calls).toHaveLength(3)
  })

  it('the ledger registry is chosen only by config; http never reads ACS as the admin', async () => {
    let queried = false
    const ledger = { query: async () => ((queried = true), []) } as unknown as LedgerClient
    const d = {
      usdcx: { admin: 'u', id: 'USDCx' },
      cc: amulet,
      cbtc: { admin: 'b', id: 'CBTC' },
    }
    const r = createRegistry(
      {
        TOKEN_REGISTRY: 'http',
        TOKEN_REGISTRY_URLS: { cc: 'http://127.0.0.1:9' },
        TOKEN_REGISTRY_TIMEOUT_MS: 200,
        TOKEN_REGISTRY_CACHE_MS: 0,
      },
      ledger,
      d,
    )
    await expect(r.transferFactory(amulet, 'f')).rejects.toBeInstanceOf(RegistryError)
    expect(queried).toBe(false)
  })
})
