import { describe, expect, it } from 'vitest'
import {
  classifyLedgerError,
  commandIdOf,
  createLedgerClient,
  LedgerUnavailableError,
  type LedgerClient,
} from '../src/ledger/client.ts'
import {
  NoCredentialError,
  parseCredentials,
  routedLedger,
  SigningForbiddenError,
} from '../src/ledger/credentials.ts'
import { isContention } from '../src/bots/runner.ts'

const contract = (cid: string) => ({
  contractEntry: {
    JsActiveContract: {
      synchronizerId: 'sync::1',
      createdEvent: {
        contractId: cid,
        templateId: 'pkg:M:T',
        createArgument: { n: cid },
        createdEventBlob: 'blob',
      },
    },
  },
})

type Call = { url: string; body: Record<string, unknown> | null }
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = (async (url: URL, init: RequestInit) => {
    const c = { url: String(url), body: init.body ? JSON.parse(String(init.body)) : null }
    calls.push(c)
    return handler(c)
  }) as unknown as typeof fetch
  return { f, calls }
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

describe('B-4, I-20: paginated ACS', () => {
  it('reads every page at one offset and passes the page token', async () => {
    const { f, calls } = fakeFetch(({ body }) =>
      body?.pageToken === 'p2'
        ? json({ activeContracts: [contract('c3')], activeAtOffset: 42 })
        : json({
            activeContracts: [contract('c1'), contract('c2')],
            activeAtOffset: 42,
            nextPageToken: 'p2',
          }),
    )
    const ledger = createLedgerClient(
      { LEDGER_API_URL: 'http://l', LEDGER_PAGE_SIZE: 2 },
      undefined,
      f,
    )
    const got = await ledger.query('op::1', { templateId: 'pkg:M:T' })
    expect(got.map((c) => c.contractId)).toEqual(['c1', 'c2', 'c3'])
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/v2/state/active-contracts-page',
      '/v2/state/active-contracts-page',
    ])
    expect(calls[0]!.body).toMatchObject({ maxPageSize: 2 })
    expect(calls[0]!.body).not.toHaveProperty('activeAtOffset')
    // the second page is at the same offset the first one returned
    expect(calls[1]!.body).toMatchObject({ pageToken: 'p2', activeAtOffset: 42 })
  })

  it('stops at LEDGER_MAX_PAGES instead of reading forever', async () => {
    const { f } = fakeFetch(() =>
      json({ activeContracts: [contract('c')], activeAtOffset: 1, nextPageToken: 'more' }),
    )
    const ledger = createLedgerClient(
      { LEDGER_API_URL: 'http://l', LEDGER_MAX_PAGES: 3 },
      undefined,
      f,
    )
    await expect(ledger.query('op::1', { templateId: 't' })).rejects.toThrow(/exceeds 3 pages/)
  })

  it('falls back to the old endpoint on a node without active-contracts-page', async () => {
    const { f, calls } = fakeFetch(({ url }) => {
      const path = new URL(url).pathname
      if (path === '/v2/state/active-contracts-page') return json({ cause: 'not found' }, 404)
      if (path === '/v2/state/ledger-end') return json({ offset: 7 })
      return json([contract('old')])
    })
    const ledger = createLedgerClient({ LEDGER_API_URL: 'http://l' }, undefined, f)
    expect((await ledger.query('op::1', { templateId: 't' })).map((c) => c.contractId)).toEqual([
      'old',
    ])
    await ledger.query('op::1', { templateId: 't' })
    // the second request goes straight to the old method
    expect(calls.filter((c) => c.url.endsWith('active-contracts-page'))).toHaveLength(1)
  })
})

describe('B-15: deterministic commandId', () => {
  const cmd = [
    { ExerciseCommand: { templateId: 't', contractId: 'c', choice: 'X', choiceArgument: {} } },
  ]
  it('the same step gives the same id, another step another id', () => {
    expect(commandIdOf('u', ['a', 'b'], cmd)).toBe(commandIdOf('u', ['b', 'a'], cmd))
    expect(commandIdOf('u', ['a'], cmd)).not.toBe(commandIdOf('u2', ['a'], cmd))
    const other = [{ ExerciseCommand: { ...cmd[0]!.ExerciseCommand, contractId: 'd' } }]
    expect(commandIdOf('u', ['a'], cmd)).not.toBe(commandIdOf('u', ['a'], other))
  })
  it('submit sends it, an explicit id wins', async () => {
    const { f, calls } = fakeFetch(() => json({ transaction: { updateId: 'u1', events: [] } }))
    const ledger = createLedgerClient(
      { LEDGER_API_URL: 'http://l', LEDGER_USER_ID: 'bot' },
      undefined,
      f,
    )
    await ledger.submit(['a'], cmd)
    await ledger.submit(['a'], cmd)
    await ledger.submit(['a'], cmd, [], [], { commandId: 'faucet-1' })
    const ids = calls.map((c) => (c.body!.commands as { commandId: string }).commandId)
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).toBe(commandIdOf('bot', ['a'], cmd))
    expect(ids[2]).toBe('faucet-1')
  })
})

describe('A-8: a timeout is not a rejection', () => {
  it('wraps network failures and timeouts as LedgerUnavailableError', async () => {
    const f = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      })
    }) as unknown as typeof fetch
    const ledger = createLedgerClient({ LEDGER_API_URL: 'http://l' }, undefined, f)
    const err = await ledger.submit(['a'], []).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LedgerUnavailableError)
    expect(classifyLedgerError(err)).toBe('transient')
    expect(isContention(err)).toBe(true)
  })
  it('an HTML 502 from a proxy is unavailable, not a crash', async () => {
    const f = (async () =>
      new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch
    const ledger = createLedgerClient({ LEDGER_API_URL: 'http://l' }, undefined, f)
    const err = await ledger.ledgerEnd().catch((e: unknown) => e)
    expect(classifyLedgerError(err)).toBe('transient')
  })
  it('classifies errors', () => {
    expect(classifyLedgerError(new Error('HTTP 503: UNAVAILABLE'))).toBe('transient')
    expect(classifyLedgerError(new Error('fetch failed'))).toBe('transient')
    expect(
      classifyLedgerError(new Error('DUPLICATE_COMMAND(10,x): a command with the given id')),
    ).toBe('duplicate')
    expect(classifyLedgerError(new Error('GeneralError: nothing to liquidate'))).toBe('rejected')
    expect(isContention(new Error('GeneralError: nothing to liquidate'))).toBe(false)
  })
})

describe('B-1: role credentials and routing', () => {
  it('parses per-role credentials with identities', () => {
    const c = parseCredentials({
      LEDGER_TOKEN_URL: 'https://kc/token',
      LEDGER_ORACLE_CLIENT_ID: 'lending-oracle',
      LEDGER_ORACLE_CLIENT_SECRET_FILE: '/run/secrets/oracle',
      LEDGER_OPERATOR_TOKEN: 'h.eyJzdWIiOiJvcGVyYXRvci11c2VyIn0.s',
      LEDGER_LIQUIDATOR_TOKEN: 'opaque',
      LEDGER_LIQUIDATOR_USER_ID: 'liq-user',
    })
    expect(c.oracle).toMatchObject({
      kind: 'client-credentials',
      identity: 'client:lending-oracle',
    })
    expect(c.operator).toMatchObject({ kind: 'static', identity: 'operator-user' })
    expect(c.liquidator).toMatchObject({ identity: 'liq-user', userId: 'liq-user' })
    expect(c.default).toBeUndefined()
    expect(c.backstop).toBeUndefined()
  })

  const d = { operator: 'op::1', oracle: 'or::1', liquidator: 'liq::1', backstop: 'bs::1' }
  const client = (name: string, log: string[]) =>
    ({
      query: async (party: string) => {
        log.push(`${name}:query:${party}`)
        return []
      },
      submit: async (actAs: string[]) => {
        log.push(`${name}:submit:${actAs.join('+')}`)
        return { updateId: 'u', events: [] }
      },
      updates: async (party: string) => {
        log.push(`${name}:updates:${party}`)
        return { transactions: [], lastOffset: null, count: 0 }
      },
    }) as unknown as LedgerClient

  it('each role submits with its own user; operator reads with the reader user', async () => {
    const log: string[] = []
    const r = routedLedger({
      deployment: d,
      clients: {
        operator: client('operator', log),
        oracle: client('oracle', log),
        reader: client('reader', log),
      },
      fallback: false,
      signForOthers: false,
    })
    await r.submit(['or::1'], [])
    await r.submit(['op::1'], [])
    await r.query('op::1', { templateId: 't' })
    expect(log).toEqual(['oracle:submit:or::1', 'operator:submit:op::1', 'reader:query:op::1'])
    await expect(r.submit(['liq::1'], [])).rejects.toBeInstanceOf(NoCredentialError)
  })

  it('on testnet the backend does not sign for guardian, treasury, council or users', async () => {
    const log: string[] = []
    const r = routedLedger({
      deployment: d,
      clients: { operator: client('operator', log), default: client('default', log) },
      fallback: false,
      signForOthers: false,
    })
    await expect(r.submit(['guardian::1'], [])).rejects.toBeInstanceOf(SigningForbiddenError)
    await expect(r.submit(['op::1', 'council1::1'], [])).rejects.toBeInstanceOf(
      SigningForbiddenError,
    )
    // the default user can read as other parties
    await r.query('alice::1', { templateId: 't' })
    expect(log).toEqual(['default:query:alice::1'])
  })

  it('on DevNet missing roles fall back to the default user', async () => {
    const log: string[] = []
    const r = routedLedger({
      deployment: d,
      clients: { default: client('default', log) },
      fallback: true,
      signForOthers: true,
    })
    await r.submit(['liq::1'], [])
    await r.submit(['alice::1'], [])
    expect(log).toEqual(['default:submit:liq::1', 'default:submit:alice::1'])
  })

  it('refuses actAs spanning two ledger users', async () => {
    const r = routedLedger({
      deployment: d,
      clients: { operator: client('o', []), oracle: client('r', []) },
      fallback: false,
      signForOthers: false,
    })
    await expect(r.submit(['op::1', 'or::1'], [])).rejects.toThrow(/several ledger users/)
  })
})
