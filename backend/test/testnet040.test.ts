/**
 * Backend for lending-core / lending-governance 0.4.0 (fix-daml.md, "Needed from others" 1–11).
 */
import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { logFormat } from '../src/app.ts'
import { createMaintenance } from '../src/bots/maintenance.ts'
import { createOracle, isBootstrapFeed } from '../src/bots/oracle.ts'
import type { PriceSource } from '../src/bots/prices.ts'
import { loadConfig } from '../src/config.ts'
import type { Deployment } from '../src/deployment.ts'
import { type LedgerClient, publicMessage } from '../src/ledger/client.ts'
import { TEMPLATES } from '../src/ledger/ids.ts'
import { createCommandBuilder } from '../src/protocol/commands.ts'
import { explainRejection } from '../src/protocol/errors.ts'
import { createGovernance, needsTrusted } from '../src/protocol/governance.ts'
import { feedFor, type Reader, type Snapshot } from '../src/protocol/reader.ts'
import type { TokenRegistry } from '../src/protocol/registry.ts'
import type { ParameterChangeProposalPayload, Roles } from '../src/protocol/types.ts'
import { poolView } from '../src/protocol/views.ts'
import { sessionFor, TEST_SECRET } from './session.ts'

const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger
const p = (n: string) => `${n}::1220abcdef0123456789`
const d = {
  operator: p('Operator'),
  oracle: p('Oracle'),
  guardian: p('Guardian'),
  treasury: p('Treasury'),
  backstop: p('Backstop'),
  liquidator: p('Liquidator'),
  testers: [],
  usdcx: { admin: p('Usdcx'), id: 'USDCx' },
  cc: { admin: p('Dso'), id: 'Amulet' },
  cbtc: { admin: p('Cbtc'), id: 'CBTC' },
} as unknown as Deployment
const roles: Roles = {
  operator: d.operator,
  oracle: d.oracle,
  guardian: d.guardian,
  treasury: d.treasury,
  backstop: d.backstop,
  liquidators: [d.liquidator],
}
const M1 = p('Member1')
const M2 = p('Member2')
const M3 = p('Member3')

const nowIso = () => new Date().toISOString()
const quotes = (lo: string, hi = lo) => [
  { source: 'a', price: lo, observedAt: nowIso() },
  { source: 'b', price: hi, observedAt: nowIso() },
]
const feed = (cid: string, instrumentId: unknown, lo: string, hi = lo, oracle = d.oracle) => ({
  contractId: cid,
  templateId: 'x:Lending.Oracle:PriceFeed',
  createdEventBlob: 'blob',
  synchronizerId: 'sync',
  payload: { oracle, instrumentId, quotes: quotes(lo, hi), observers: [d.operator] },
})
const params = {
  debtInstrument: d.usdcx,
  rateModel: {
    baseRate: '0',
    slope1: '0',
    slope2: '0',
    optimalUtilization: '0.8',
    maxUtilization: '0.9',
    reserveFactor: '0',
  },
  totalBorrowCap: '1000000',
  maxDebtPerUser: '1000000',
  minLoan: '1',
  liquidationRiskWarning: '0.71',
  maxPriceAgeSeconds: '300',
  maxSourceDeviation: '0.03',
  maxLiquidationSourceDeviation: '0.15',
  maxDebtDepeg: '0.1',
  maxClockSkewSeconds: '30',
  storeFrontPriceFactor: '0.8',
  targetReserves: '50000',
}
const ccParams = {
  collateralInstrument: d.cc,
  borrowCollateralFactor: '0.3',
  liquidateCollateralFactor: '0.4',
  liquidationFactor: '0.93',
  supplyCap: '100000000',
  minCollateralAmount: '1',
  requiresReserveAttestation: false,
  minReserveCoverage: '1',
  maxAttestationAgeSeconds: '86400',
}
const market = () => ({
  totalCollateral: '10000',
  protocolCollateral: '50',
  protocolCollateralBasis: '5',
})

function snapshot(
  over: {
    oracle?: string
    usdcx?: [string, string]
    governors?: string[]
    cc?: [string, string]
  } = {},
): Snapshot {
  const cfgRoles = { ...roles, oracle: over.oracle ?? d.oracle }
  return {
    config: {
      contractId: 'cfg',
      templateId: 'x:Lending.Config:ProtocolConfig',
      createdEventBlob: 'cfg-blob',
      synchronizerId: 'sync',
      payload: {
        roles: cfgRoles,
        governors: over.governors ?? [],
        params,
        marketParams: [['CC', ccParams]],
        transferFactories: [
          [d.usdcx, 'f-usdcx'],
          [d.cc, 'f-cc'],
          [d.cbtc, 'f-cbtc'],
        ],
      },
    },
    pool: {
      contractId: 'pool',
      templateId: 'x:Lending.Pool:Pool',
      createdEventBlob: 'pool-blob',
      synchronizerId: 'sync',
      payload: {
        operator: d.operator,
        governors: over.governors ?? [],
        markets: [['CC', market()]],
        state: {
          totalSupplyPrincipal: '100000',
          totalBorrowPrincipal: '1000',
          supplyIndex: '1',
          borrowIndex: '1',
          cash: '99100',
          lastUpdate: nowIso(),
        },
      },
    },
    pause: {
      contractId: 'pause',
      templateId: 'x:Lending.Pause:PauseState',
      createdEventBlob: 'pause-blob',
      synchronizerId: 'sync',
      payload: {
        operator: d.operator,
        guardian: d.guardian,
        flags: {
          borrowPaused: false,
          collateralWithdrawPaused: false,
          supplyWithdrawPaused: false,
          absorbPaused: false,
          buyPaused: false,
        },
      },
    },
    markets: new Map([['CC', market()]]),
    marketParams: new Map([['CC', ccParams]]),
    feeds: [
      feed('feed-usdcx', d.usdcx, ...(over.usdcx ?? ['1', '1'])),
      feed('feed-cc', d.cc, ...(over.cc ?? ['0.215', '0.2365'])),
      // feeds of the previous oracle remain in the ACS after rotation
      feed('old-usdcx', d.usdcx, '1', '1', p('OldOracle')),
      feed('old-cc', d.cc, '0.5', '0.5', p('OldOracle')),
    ],
    attestations: [],
    featuredAppRight: null,
  } as unknown as Snapshot
}

const account = (principal = '-500') => ({
  contractId: 'acc',
  templateId: 'x:Lending.Account:Account',
  createdEventBlob: 'b',
  synchronizerId: 'sync',
  payload: {
    operator: d.operator,
    owner: p('Alice'),
    principal,
    collateral: [['CC', '10000']],
  },
})

const opHoldings = (instrument: unknown) =>
  Array.from({ length: 3 }, (_, i) => ({
    contract: {
      contractId: `op-${(instrument as { id: string }).id}-${i}`,
      templateId: 'h',
      createdEventBlob: 'b',
      synchronizerId: 's',
    },
    view: { owner: d.operator, amount: '100000', instrumentId: instrument, lock: null },
  }))

const registry: TokenRegistry = {
  transferFactory: async (_i, cid) => ({
    factoryCid: cid,
    disclosed: [],
    transferExtraArgs: { context: { values: {} }, meta: { values: {} } },
    acceptExtraArgs: { context: { values: {} }, meta: { values: {} } },
  }),
}

function readerWith(s: Snapshot, acc: ReturnType<typeof account> | null, extra = {}) {
  return {
    snapshot: async () => s,
    account: async () => acc,
    holdings: async (party: string, i: { id: string }) =>
      party === d.operator ? opHoldings(i) : [],
    ...extra,
  } as unknown as Reader
}

// ------------------------------------------------------------------ §4

describe('views for 0.4.0', () => {
  const now = new Date()
  it('§4: feeds and prices come only from config.roles.oracle', () => {
    const s = snapshot()
    expect(feedFor(s, d.cc)?.contractId).toBe('feed-cc')
    const rotated = snapshot({ oracle: p('NewOracle') })
    expect(feedFor(rotated, d.cc)).toBeUndefined()
    expect(poolView(d, rotated, now).prices['Amulet']).toBeNull()
  })
})

// ------------------------------------------------------------------ commands

describe('commands for 0.4.0', () => {
  it('§4: after an oracle rotation without new feeds — PRICE_FEED_WRONG_ORACLE', async () => {
    const c = createCommandBuilder(
      d,
      readerWith(snapshot({ oracle: p('NewOracle') }), account()),
      registry,
    )
    await expect(c.withdrawCollateral(p('Alice'), 'CC', '10')).rejects.toMatchObject({
      code: 'PRICE_FEED_WRONG_ORACLE',
    })
  })

  it('1: Login always carries an expiry of at most 10 minutes', async () => {
    const c = createCommandBuilder(d, readerWith(snapshot(), null), registry)
    const cmd = await c.login(p('Alice'), 'n', new Date(Date.now() + 86_400_000))
    const args = (cmd.commands[0] as { CreateCommand: { createArguments: { expiresAt: string } } })
      .CreateCommand.createArguments
    expect(typeof args.expiresAt).toBe('string')
    expect(Date.parse(args.expiresAt)).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  })
})

// ------------------------------------------------------------------ 5, 6, 7: refusals

describe('rejections of 0.4.0 map to clear 4xx', () => {
  const canton = (msg: string) =>
    `NOT_EXECUTED: Interpretation error: Error: User abort: GeneralError: ${msg}\nUsing Canton…`
  it.each([
    [
      'market deficit not covered: withdrawals wait for recapitalization',
      'WITHDRAWALS_WAIT_FOR_RECAPITALIZATION',
      409,
    ],
    ['collateral not for sale: reserves at target', 'COLLATERAL_SALE_CLOSED', 409],
    ['pays more than the whole stock costs', 'PURCHASE_ABOVE_STOCK', 409],
    ['a purchase is at least 1 USDCx unless it takes the whole stock', 'PURCHASE_TOO_SMALL', 400],
    [
      'reserves are negative: withdrawals and loans wait for recapitalization',
      'WITHDRAWALS_WAIT_FOR_RECAPITALIZATION',
      409,
    ],
    ['price feed: wrong oracle', 'PRICE_FEED_WRONG_ORACLE', 409],
    ['reserve attestation: wrong oracle', 'PRICE_FEED_WRONG_ORACLE', 409],
    ['price feed: stale price', 'PRICE_UNAVAILABLE', 409],
    ['login expired', 'LOGIN_EXPIRED', 401],
    ['login lifetime exceeds maxLoginTtl', 'LOGIN_TTL_EXCEEDED', 401],
  ])('%s → %s', (msg, code, status) => {
    const r = explainRejection(publicMessage(canton(msg)))
    expect(r).toMatchObject({ code, status })
  })
  it('other rejections stay unmapped (422 with the contract text)', () => {
    expect(explainRejection(publicMessage(canton('loan exceeds LTV')))).toBeNull()
  })
})

// ------------------------------------------------------------------ 9, 11: council

describe('governance commands (lending-governance 0.4.0)', () => {
  const members = [M1, M2, M3]
  const councilCid = 'council-1'
  const proposal = (over: Partial<ParameterChangeProposalPayload> = {}) => ({
    contractId: 'prop-1',
    payload: {
      operator: d.operator,
      members,
      threshold: '2',
      proposalId: 'p1',
      description: '',
      proposer: M1,
      newParams: params,
      newMarketParams: [],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      approvals: [M1, M2],
      newRoles: null,
      ...over,
    } as unknown as ParameterChangeProposalPayload,
  })
  const rotation = (over: Record<string, unknown> = {}) => ({
    contractId: 'rot-1',
    payload: {
      operator: d.operator,
      members,
      threshold: '2',
      rotationId: 'r1',
      proposer: M1,
      newMembers: [M1, M2, p('New')],
      newThreshold: '2',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      approvals: [M1, M2],
      joined: [p('New')],
      ...over,
    },
  })
  const income = {
    contractId: 'inc-1',
    payload: {
      operator: d.operator,
      members,
      threshold: '2',
      proposalId: 'i1',
      proposer: M1,
      treasury: d.treasury,
      reservesAmount: '50',
      collateral: [{ _1: 'CC', _2: '20' }],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      approvals: [M1, M2],
    },
  }
  const gov = (extra: Record<string, unknown> = {}) =>
    createGovernance(
      d,
      readerWith(snapshot({ governors: members }), null, {
        councils: async () => [
          { contractId: councilCid, payload: { operator: d.operator, members, threshold: '2' } },
        ],
        proposals: async () => [proposal()],
        rotations: async () => [rotation()],
        incomeProposals: async () => [income],
        ...extra,
      }),
      registry,
    )
  const ex = (c: { commands: unknown[] }) =>
    (c.commands[0] as { ExerciseCommand: Record<string, unknown> }).ExerciseCommand as {
      templateId: string
      contractId: string
      choice: string
      choiceArgument: Record<string, unknown>
    }
  const later = new Date(Date.now() + 3_600_000)

  it('Council_Propose with newRoles, the rest from the current config', async () => {
    const newRoles = { ...roles, oracle: p('NewOracle') }
    const c = await gov().proposeParams(M1, {
      proposalId: 'roles-1',
      description: 'rotate the oracle',
      expiresAt: later,
      newRoles,
    })
    const e = ex(c)
    expect(c.actAs).toEqual([M1])
    expect(e).toMatchObject({
      templateId: TEMPLATES.governanceCouncil,
      contractId: councilCid,
      choice: 'Council_Propose',
    })
    expect(e.choiceArgument).toMatchObject({
      proposer: M1,
      configCid: 'cfg',
      newParams: params,
      newRoles,
      newTransferFactories: null,
      featuredAppRightChange: null,
    })
  })

  it('refuses a non-member, an operator change and a threshold path for trusted changes', async () => {
    await expect(
      gov().proposeParams(p('Outsider'), { proposalId: 'x', description: '', expiresAt: later }),
    ).rejects.toThrow(/council member/)
    await expect(
      gov().proposeParams(M1, {
        proposalId: 'x',
        description: '',
        expiresAt: later,
        newRoles: { ...roles, operator: p('Evil') },
      }),
    ).rejects.toThrow(/operator cannot change/)
    const trusted = gov({
      proposals: async () => [proposal({ newRoles: { ...roles, oracle: p('NewOracle') } })],
    })
    await expect(trusted.executeProposal(M1, 'prop-1')).rejects.toThrow(/Proposal_ExecuteTrusted/)
    expect(needsTrusted(proposal({ newRoles: roles }).payload, roles)).toBe(false)
  })

  it('Proposal_ExecuteTrusted is prepared for the operator only at the threshold', async () => {
    const c = await gov().executeTrusted('p1')
    expect(c.actAs).toEqual([d.operator])
    expect(ex(c)).toMatchObject({
      choice: 'Proposal_ExecuteTrusted',
      // review 03.10, item 14: the pause goes along, so a new guardian gets it in the same transaction
      choiceArgument: { configCid: 'cfg', pauseCid: expect.any(String) },
    })
    const short = gov({ proposals: async () => [proposal({ approvals: [M1] })] })
    await expect(short.executeTrusted('p1')).rejects.toThrow(/1 of 2 approvals/)
  })

  it('rotation: propose, join by the new member, execute with the pool disclosed', async () => {
    const g = gov()
    const propose = await g.proposeRotation(M1, {
      rotationId: 'r2',
      newMembers: [M1, M2, p('New')],
      newThreshold: 2,
      expiresAt: later,
    })
    expect(ex(propose)).toMatchObject({
      choice: 'Council_ProposeRotation',
      choiceArgument: { newThreshold: '2', newMembers: [M1, M2, p('New')] },
    })
    await expect(
      g.proposeRotation(M1, {
        rotationId: 'r',
        newMembers: [M1, d.operator],
        newThreshold: 1,
        expiresAt: later,
      }),
    ).rejects.toThrow(/operator cannot be a council member/)
    const joinG = gov({ rotations: async () => [rotation({ joined: [] })] })
    const join = await joinG.joinRotation(p('New'), 'rot-1')
    expect(join.actAs).toEqual([p('New')])
    expect(ex(join)).toMatchObject({
      choice: 'Rotation_Join',
      choiceArgument: { joiner: p('New') },
    })
    await expect(joinG.joinRotation(M1, 'rot-1')).rejects.toThrow(/new council member/)
    await expect(joinG.executeRotation(M1, 'rot-1')).rejects.toThrow(/not joined/)
    const exec = await g.executeRotation(M2, 'rot-1')
    expect(ex(exec)).toMatchObject({
      choice: 'Rotation_Execute',
      choiceArgument: { executor: M2, councilCid, configCid: 'cfg', poolCid: 'pool' },
    })
    expect(exec.disclosedContracts.map((c) => c.contractId).sort()).toEqual(['cfg', 'pool'])
  })

  it('formation: the operator executes with councilCid None', async () => {
    const g = gov({
      rotations: async () => [
        rotation({
          members: [],
          threshold: '0',
          approvals: [],
          proposer: d.operator,
          joined: [M1, M2, p('New')],
        }),
      ],
    })
    const exec = await g.executeRotation(d.operator, 'rot-1')
    expect(ex(exec).choiceArgument).toMatchObject({ executor: d.operator, councilCid: null })
    await expect(g.executeRotation(p('Outsider'), 'rot-1')).rejects.toThrow(/council member/)
  })

  it('reserves: the treasury executes with pool, config and the USDCx payout disclosed', async () => {
    const g = gov()
    const propose = await g.proposeIncome(M1, {
      proposalId: 'i2',
      reservesAmount: '50',
      expiresAt: later,
    })
    expect(ex(propose)).toMatchObject({
      choice: 'Council_ProposeIncome',
      choiceArgument: { treasury: d.treasury, reservesAmount: '50' },
    })
    await expect(
      g.proposeIncome(M1, { proposalId: 'i3', reservesAmount: '0', expiresAt: later }),
    ).rejects.toThrow(/positive/)
    const exec = await g.executeIncome(d.treasury, 'inc-1')
    expect(exec.actAs).toEqual([d.treasury])
    const arg = ex(exec).choiceArgument as {
      reservesPayout: { factoryCid: string; inputHoldingCids: string[] }
    }
    expect(ex(exec).choice).toBe('IncomeProposal_Execute')
    expect(arg.reservesPayout.factoryCid).toBe('f-usdcx')
    expect(arg.reservesPayout.inputHoldingCids).toEqual(['op-USDCx-0'])
    expect(Object.keys(ex(exec).choiceArgument as object).sort()).toEqual(
      ['configCid', 'poolCid', 'reservesPayout'].sort(),
    )
    expect(exec.disclosedContracts.map((c) => c.contractId).sort()).toEqual(
      ['cfg', 'op-USDCx-0', 'pool'].sort(),
    )
    await expect(g.executeIncome(M1, 'inc-1')).rejects.toThrow(/Only the treasury/)
  })

  it('view marks trusted proposals and formation rotations', async () => {
    const v = await gov({
      proposals: async () => [proposal({ newRoles: { ...roles, guardian: p('G2') } })],
    }).view()
    expect(v.council).toEqual({ contractId: councilCid, members, threshold: 2 })
    expect(v.proposals[0]).toMatchObject({ trusted: true })
    expect(v.rotations[0]).toMatchObject({ formation: false, newThreshold: 2 })
    expect(v.income[0]).toMatchObject({ reservesAmount: '50.0000000000' })
  })
})

// ------------------------------------------------------------------ 7, 10: oracle

describe('oracle bot with 0.4.0 feeds', () => {
  const T = Date.now()
  const iso = (t: number) => new Date(t).toISOString()
  const src = (name: string, price: string): PriceSource => ({
    name,
    fetch: async () => ({
      usdcx: { price: '1', observedAt: iso(T) },
      cc: { price, observedAt: iso(T) },
      cbtc: { price: '60000', observedAt: iso(T) },
    }),
  })
  function fakeLedger(feeds: unknown[]) {
    const submitted: { kind: string; arg: Record<string, unknown>; cid?: string }[] = []
    const ledger = {
      query: async () => feeds,
      submit: async (_a: string[], cmds: Record<string, Record<string, unknown>>[]) => {
        for (const c of cmds) {
          if (c.CreateCommand)
            submitted.push({ kind: 'create', arg: c.CreateCommand.createArguments as never })
          else
            submitted.push({
              kind: 'exercise',
              arg: c.ExerciseCommand!.choiceArgument as never,
              cid: c.ExerciseCommand!.contractId as string,
            })
        }
        return { updateId: 'u', events: [] }
      },
    } as unknown as LedgerClient
    return { ledger, submitted }
  }
  const bootstrap = (cid: string, instrumentId: unknown, price: string, oracle = d.oracle) => ({
    contractId: cid,
    payload: {
      oracle,
      instrumentId,
      observers: [d.operator],
      quotes: [
        { source: 'bootstrap-a', price, observedAt: iso(T - 60_000) },
        { source: 'bootstrap-b', price, observedAt: iso(T - 60_000) },
      ],
    },
  })

  it('10: replaces deployProd bootstrap quotes at once and whole, past the circuit breaker', async () => {
    expect(isBootstrapFeed([{ source: 'bootstrap-a' }, { source: 'bootstrap-b' }])).toBe(true)
    expect(isBootstrapFeed([{ source: 'bootstrap-a' }, { source: 'coingecko' }])).toBe(false)
    // stub 0.1, market 0.2: a 100 % jump > maxStep, but the quotes are only a minute old
    const { ledger, submitted } = fakeLedger([
      bootstrap('f-usdcx', d.usdcx, '1'),
      bootstrap('f-cc', d.cc, '0.1'),
      bootstrap('f-cbtc', d.cbtc, '60000'),
    ])
    const publish = createOracle(
      ledger,
      d,
      [src('s1', '0.2'), src('s2', '0.2')],
      log,
      {},
      undefined,
      () => T,
    )
    await publish()
    const cc = submitted.find((s) => s.cid === 'f-cc')!
    const newQuotes = cc.arg.newQuotes as { source: string }[]
    expect(newQuotes.map((q) => q.source).sort()).toEqual(['s1', 's2'])
  })

  it('7: publishes only to its own feeds and creates them after a rotation', async () => {
    const { ledger, submitted } = fakeLedger([
      bootstrap('old-usdcx', d.usdcx, '1', p('OldOracle')),
      bootstrap('old-cc', d.cc, '0.1', p('OldOracle')),
    ])
    const publish = createOracle(
      ledger,
      d,
      [src('s1', '0.2'), src('s2', '0.2')],
      log,
      {},
      undefined,
      () => T,
    )
    await publish()
    expect(submitted.every((s) => s.kind === 'create')).toBe(true)
    expect(submitted).toHaveLength(3)
    expect(submitted[0]!.arg).toMatchObject({ oracle: d.oracle, observers: [d.operator] })
  })

  it('7: the live attestation bot creates its own attestation when it has none', async () => {
    const { ledger, submitted } = fakeLedger([
      {
        contractId: 'old',
        payload: {
          oracle: p('OldOracle'),
          instrumentId: d.cbtc,
          coverage: '1',
          attestedAt: iso(T),
        },
      },
    ])
    const m = createMaintenance(ledger, {} as Reader, registry, d, 'live', log, {
      name: 'por',
      fetch: async () => ({ coverage: '1.01', attestedAt: iso(T) }),
    })
    expect(await m.attestation()).toBe(1)
    expect(submitted[0]).toMatchObject({
      kind: 'create',
      arg: { oracle: d.oracle, instrumentId: d.cbtc, coverage: '1.01', observers: [d.operator] },
    })
  })
})

// ------------------------------------------------------------------ RELEASE_SHA, LOG_FORMAT

describe('RELEASE_SHA and LOG_FORMAT', () => {
  it('LOG_FORMAT decides the format regardless of NODE_ENV; without it — TTY', () => {
    expect(logFormat({ LOG_FORMAT: 'pretty' }, false)).toBe('pretty')
    expect(logFormat({ LOG_FORMAT: 'json' }, true)).toBe('json')
    expect(logFormat({ LOG_FORMAT: undefined }, true)).toBe('pretty')
    expect(logFormat({ LOG_FORMAT: undefined }, false)).toBe('json')
    expect(() => loadConfig({ LOG_FORMAT: 'xml' })).toThrow()
  })

  it('accepts a full Canton contract id as a route parameter (no 414)', async () => {
    const { buildApp } = await import('../src/app.ts')
    const app = await buildApp(loadConfig({ LEDGER_API_URL: 'http://127.0.0.1:9' }), {
      withProtocol: false,
    })
    app.get('/probe/:cid', async (req) => ({ cid: (req.params as { cid: string }).cid }))
    const cid = '00' + 'e6'.repeat(69)
    const res = await app.inject({ method: 'GET', url: `/probe/${cid}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ cid })
    await app.close()
  })

  it('/health echoes RELEASE_SHA', async () => {
    const { buildApp } = await import('../src/app.ts')
    const app = await buildApp(
      loadConfig({ LEDGER_API_URL: 'http://127.0.0.1:9', RELEASE_SHA: 'b31b321' }),
      { withProtocol: false },
    )
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toMatchObject({ status: 'ok', release: 'b31b321' })
    await app.close()
    expect(() => loadConfig({ RELEASE_SHA: 'bad sha; rm' })).toThrow()
  })
})

// ------------------------------------------------------------------ routes

describe('0.4.0 routes without a ledger', () => {
  it('commands and governance need the own session; unknown actions 404', async () => {
    const { writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { buildApp } = await import('../src/app.ts')
    const path = join(tmpdir(), `deployment-040-${process.pid}.json`)
    const alice = p('Alice')
    const bob = p('Bob')
    writeFileSync(path, JSON.stringify({ ...d, alice, bob }))
    const app = await buildApp(
      loadConfig({
        LEDGER_API_URL: 'http://127.0.0.1:9',
        DEPLOYMENT_PATH: path,
        AUTH_SECRET: TEST_SECRET,
        DATABASE_PATH: ':memory:',
      }),
    )
    const token = sessionFor(alice)
    const headers = { 'x-session-token': token }
    const other = await app.inject({
      method: 'POST',
      url: '/commands/withdraw-collateral',
      headers,
      payload: { party: bob, marketId: 'CC', amount: '1' },
    })
    expect(other.statusCode).toBe(403)
    const bad = await app.inject({
      method: 'POST',
      url: '/commands/withdraw-collateral',
      headers,
      payload: { party: alice, marketId: 'DOGE', amount: '1' },
    })
    expect(bad.statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/governance' })).statusCode).toBe(401)
    const unknown = await app.inject({
      method: 'POST',
      url: '/governance/proposals/cid-1/steal',
      headers,
      payload: { party: alice },
    })
    expect(unknown.statusCode).toBe(404)
    const proto = await app.inject({
      method: 'POST',
      url: '/governance/constructor/cid-1/approve',
      headers,
      payload: { party: alice },
    })
    expect(proto.statusCode).toBe(404)
    const foreign = await app.inject({
      method: 'POST',
      url: '/governance/rotations/cid-1/join',
      headers,
      payload: { party: bob },
    })
    expect(foreign.statusCode).toBe(403)
    // review 03.10, item 2: the body the council form sends (no collateral field) passes validation;
    // the ledger is unreachable here, so the answer is not a 400
    const income = await app.inject({
      method: 'POST',
      url: '/governance/income',
      headers,
      payload: {
        party: alice,
        proposalId: 'income-1',
        reservesAmount: '100',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    })
    expect(income.statusCode).not.toBe(400)
    await app.close()
  })
})
