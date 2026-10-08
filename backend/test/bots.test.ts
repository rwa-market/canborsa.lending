import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { createAccountBot, planAccountRequests } from '../src/bots/accounts.ts'
import { exclusive } from '../src/bots/runner.ts'
import { assertSafeBots } from '../src/config.ts'
import type { Deployment } from '../src/deployment.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import type { Reader } from '../src/protocol/reader.ts'
import type { TokenRegistry } from '../src/protocol/registry.ts'

const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger
const d = {
  operator: 'op::1',
  oracle: 'oracle::1',
  guardian: 'g::1',
  treasury: 't::1',
  backstop: 'backstop::1',
  liquidator: 'liq::1',
  usdcx: { admin: 'u', id: 'USDCx' },
  cc: { admin: 'c', id: 'CC' },
  cbtc: { admin: 'b', id: 'CBTC' },
} as Deployment

interface FakeHolding {
  contract: never
  view: { owner: string; amount: string; lock: null; instrumentId: { admin: string; id: string } }
}

// ---------------------------------------------------------------- fake ledger

const now = () => new Date().toISOString()
const feed = (cid: string, instrumentId: { admin: string; id: string }, price: string) => ({
  contractId: cid,
  payload: {
    oracle: d.oracle,
    instrumentId,
    observers: [],
    quotes: [
      { source: 'a', price, observedAt: now() },
      { source: 'b', price, observedAt: now() },
    ],
  },
})
const snapshot = () => ({
  config: {
    contractId: 'cfg',
    payload: {
      roles: { oracle: d.oracle },
      params: {
        rateModel: {
          baseRate: '0',
          slope1: '0',
          slope2: '0',
          optimalUtilization: '0.8',
          maxUtilization: '0.9',
          reserveFactor: '0',
        },
        maxPriceAgeSeconds: '300',
        maxClockSkewSeconds: '30',
        maxSourceDeviation: '0.02',
        maxLiquidationSourceDeviation: '0.15',
        protocolBonusShare: '0.1',
      },
      transferFactories: [
        [d.usdcx, 'f-usdcx'],
        [d.cbtc, 'f-cbtc'],
      ],
    },
  },
  pool: {
    contractId: 'pool',
    payload: {
      state: {
        totalScaledSupply: '0',
        totalScaledDebt: '0',
        supplyIndex: '1',
        borrowIndex: '1',
        cash: '0',
        reserves: '0',
        insuranceFund: '0',
        lastUpdate: now(),
      },
    },
  },
  marketParams: new Map([['CBTC', { liquidationThreshold: '0.8', collateralInstrument: d.cbtc }]]),
  markets: new Map(),
  feeds: [feed('feed-usdcx', d.usdcx, '1'), feed('feed-cbtc', d.cbtc, '40000')],
  attestations: [],
  featuredAppRight: null,
})
const account = (
  cid: string,
  owner: string,
  collateral: string,
  debt: string,
  pending?: string,
) => ({
  contractId: cid,
  payload: {
    operator: d.operator,
    owner,
    scaledSupply: '0',
    positions: [
      [
        'CBTC',
        {
          collateral,
          scaledDebt: debt,
          collateralEnabled: true,
          pendingLiquidation: pending ?? null,
        },
      ],
    ],
  },
})

interface Submitted {
  actAs: string[]
  choice: string
  arg: Record<string, unknown>
}

function fakes(state: {
  accounts?: ReturnType<typeof account>[]
  holdings?: FakeHolding[]
  bids?: unknown[]
  requests?: unknown[]
  accountRequests?: unknown[]
  fail?: (s: Submitted) => string | null
}) {
  const submitted: Submitted[] = []
  const ledger = {
    async submit(actAs: string[], commands: { ExerciseCommand: Record<string, unknown> }[]) {
      for (const c of commands) {
        const s = {
          actAs,
          choice: c.ExerciseCommand.choice as string,
          arg: c.ExerciseCommand.choiceArgument as Record<string, unknown>,
        }
        const err = state.fail?.(s)
        if (err) throw new Error(err)
        submitted.push(s)
        if (s.choice === 'LiquidationRequest_Bid') {
          // the request appears in the ACS: the next request must see the taken holdings
          state.bids = [
            ...(state.bids ?? []),
            { contractId: `bid-${submitted.length}`, payload: { executor: actAs[0], ...s.arg } },
          ]
        }
      }
      return { updateId: 'u', events: [] }
    },
  } as unknown as LedgerClient
  const reader = {
    snapshot: async () => snapshot(),
    accounts: async () => state.accounts ?? [],
    holdings: async (party: string) => (state.holdings ?? []).filter((h) => h.view.owner === party),
    liquidationBids: async () => state.bids ?? [],
    liquidationRequests: async () => state.requests ?? [],
    accountRequests: async () => state.accountRequests ?? [],
    directory: async () => ({ contractId: 'dir' }),
    roles: async () => ({
      operator: d.operator,
      oracle: d.oracle,
      guardian: d.guardian,
      treasury: d.treasury,
      backstop: d.backstop,
      liquidators: [d.liquidator],
    }),
  } as unknown as Reader
  const registry: TokenRegistry = {
    transferFactory: async (_i, cid) => ({
      factoryCid: cid,
      disclosed: [],
      transferExtraArgs: { context: { values: {} }, meta: { values: {} } },
      acceptExtraArgs: { context: { values: {} }, meta: { values: {} } },
    }),
  }
  return { ledger, reader, registry, submitted, state }
}

// ---------------------------------------------------------------- H3

/** Account request of `user` to our operator. */
const req = (cid: string, user: string) => ({
  contractId: cid,
  payload: { operator: d.operator, user },
})

describe('account requests (H4)', () => {
  it('opens at most the limit, one request per party, and rejects duplicates of holders', () => {
    const flood = Array.from({ length: 30 }, (_, i) => req(`spam-${i}`, 'mallory::1'))
    const newcomers = Array.from({ length: 15 }, (_, i) => req(`new-${i}`, `user${i}::1`))
    const plan = planAccountRequests(
      [...flood, ...newcomers, req('x', 'carol::1')],
      d.operator,
      new Set(['mallory::1']),
      { opens: 10, rejects: 20 },
    )
    expect(plan.reject).toHaveLength(20)
    expect(plan.reject.every((r) => r.payload.user === 'mallory::1')).toBe(true)
    expect(plan.open.map((r) => r.contractId)).toEqual(
      newcomers.slice(0, 10).map((r) => r.contractId),
    )
  })

  it('a party without an account gets one Directory_Open per step, not one per request', () => {
    const plan = planAccountRequests(
      [req('a', 'eve::1'), req('b', 'eve::1'), req('c', 'eve::1')],
      d.operator,
      new Set(),
    )
    expect(plan.open.map((r) => r.contractId)).toEqual(['a'])
    expect(plan.reject).toHaveLength(0)
  })

  it('ignores requests addressed to another operator', () => {
    const other = { contractId: 'o', payload: { operator: 'evil::1', user: 'eve::1' } }
    expect(planAccountRequests([other], d.operator, new Set())).toEqual({ open: [], reject: [] })
  })

  it('batches rejections into few transactions', async () => {
    const f = fakes({
      accounts: [account('m', 'mallory::1', '0', '0')],
      accountRequests: Array.from({ length: 60 }, (_, i) => req(`spam-${i}`, 'mallory::1')),
    })
    const submits: number[] = []
    const ledger = {
      submit: async (actAs: string[], cmds: never[]) => {
        submits.push(cmds.length)
        return f.ledger.submit(actAs, cmds)
      },
    } as unknown as LedgerClient
    expect(await createAccountBot(ledger, f.reader, d, log)()).toBe(60)
    expect(submits).toEqual([25, 25, 10])
  })

  it('a long accounts step does not hold the protocol lock', async () => {
    let release!: () => void
    const slow = exclusive(() => new Promise<void>((r) => (release = r)), 'accounts')
    const oracle = await Promise.race([
      exclusive(async () => 'published'),
      new Promise((r) => setTimeout(() => r('starved'), 50)),
    ])
    expect(oracle).toBe('published')
    release()
    await slow
  })
})

// ---------------------------------------------------------------- M3

describe('attestation bot (M3)', () => {
  it('refuses to start with ORACLE_MODE=live', () => {
    expect(() => assertSafeBots({ BOTS: ['oracle', 'attestation'], ORACLE_MODE: 'live' })).toThrow(
      /RESERVE_ATTESTATION_URL/,
    )
    // DevNet: live prices, test CBTC is re-signed (it has no PoR source)
    expect(() =>
      assertSafeBots({
        BOTS: ['oracle', 'attestation'],
        ORACLE_MODE: 'live',
        ATTESTATION_MODE: 'demo',
      }),
    ).not.toThrow()
    expect(() =>
      assertSafeBots({ BOTS: ['oracle', 'attestation'], ORACLE_MODE: 'demo' }),
    ).not.toThrow()
    expect(() => assertSafeBots({ BOTS: ['oracle'], ORACLE_MODE: 'live' })).not.toThrow()
  })
})
