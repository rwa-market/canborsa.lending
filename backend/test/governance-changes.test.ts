/**
 * Integration pass over the remaining audit items: GET /governance shows what a proposal changes;
 * CORS is empty by default: the frontend Origin is set by the environment.
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { corsOrigins, loadConfig } from '../src/config.ts'
import { deploymentSchema } from '../src/deployment.ts'
import { createGovernance } from '../src/protocol/governance.ts'
import { proposalChanges } from '../src/protocol/proposal-changes.ts'
import type { Reader } from '../src/protocol/reader.ts'
import type { ConfigPayload, ParameterChangeProposalPayload } from '../src/protocol/types.ts'
import { d, p, registry, roles, snapshot } from './fixtures.ts'

const M = [p('CouncilMember1'), p('CouncilMember2'), p('CouncilMember3')]
const snap = snapshot()
const config = snap.config.payload as ConfigPayload
const ccParams = config.marketParams[0]![1]

const proposal = (over: Partial<ParameterChangeProposalPayload> = {}) =>
  ({
    operator: d.operator,
    members: M,
    threshold: '2',
    proposalId: 'p1',
    description: '',
    proposer: M[0],
    // JSON API returns decimals with 10 places: "1.0000000000" equals "1" from the config
    newParams: { ...config.params, minLoan: '1.0000000000' },
    newMarketParams: [['CC', { ...ccParams }]],
    newTransferFactories: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    approvals: [M[0]],
    featuredAppRightChange: null,
    newRoles: null,
    ...over,
  }) as unknown as ParameterChangeProposalPayload

describe('proposal changes: new values against the current config', () => {
  it('an unchanged proposal changes nothing, decimals compare by value', () => {
    expect(proposalChanges(proposal(), config)).toEqual([])
  })

  it('protocol parameters, nested rate model and market parameters', () => {
    const changes = proposalChanges(
      proposal({
        newParams: {
          ...config.params,
          minLoan: '250.5',
          rateModel: { ...config.params.rateModel, slope1: '0.08' },
        },
        newMarketParams: [
          ['CC', { ...ccParams, borrowCollateralFactor: '0.25', requiresReserveAttestation: true }],
        ],
      }),
      config,
    )
    expect(changes).toEqual([
      { scope: 'protocol', target: null, field: 'rateModel.slope1', from: '0', to: '0.08' },
      { scope: 'protocol', target: null, field: 'minLoan', from: '1', to: '250.5' },
      { scope: 'market', target: 'CC', field: 'borrowCollateralFactor', from: '0.3', to: '0.25' },
      {
        scope: 'market',
        target: 'CC',
        field: 'requiresReserveAttestation',
        from: 'false',
        to: 'true',
      },
    ])
  })

  it('an added or removed market, {_1,_2} map entries are read too', () => {
    const added = proposalChanges(
      proposal({
        newMarketParams: [
          { _1: 'CC', _2: ccParams },
          { _1: 'CBTC', _2: { ...ccParams, borrowCollateralFactor: '0.6' } },
        ] as never,
      }),
      config,
    )
    expect(added).toEqual([
      expect.objectContaining({ scope: 'market', target: 'CBTC', field: '', from: null }),
    ])
    expect(added[0]!.to).toContain('"borrowCollateralFactor":"0.6"')
    const removed = proposalChanges(proposal({ newMarketParams: [] }), config)
    expect(removed).toEqual([
      expect.objectContaining({ scope: 'market', target: 'CC', field: '', to: null }),
    ])
  })

  it('roles, transfer factories and the Featured App right', () => {
    const changes = proposalChanges(
      proposal({
        newRoles: { ...roles, guardian: p('G2'), liquidators: [d.liquidator, p('L2')] },
        newTransferFactories: [
          [d.usdcx, 'f-usdcx'],
          [d.cc, 'f-cc-2'],
        ],
        featuredAppRightChange: { tag: 'FeaturedRight_Set', value: 'right-1' },
      }),
      config,
    )
    expect(changes).toEqual([
      { scope: 'roles', target: null, field: 'guardian', from: d.guardian, to: p('G2') },
      {
        scope: 'roles',
        target: null,
        field: 'liquidators',
        from: d.liquidator,
        to: `${d.liquidator}, ${p('L2')}`,
      },
      {
        scope: 'factories',
        target: `${d.cc.admin}::${d.cc.id}`,
        field: '',
        from: 'f-cc',
        to: 'f-cc-2',
      },
      {
        scope: 'factories',
        target: `${d.cbtc.admin}::${d.cbtc.id}`,
        field: '',
        from: 'f-cbtc',
        to: null,
      },
      { scope: 'featuredAppRight', target: null, field: '', from: null, to: 'right-1' },
    ])
    // removing a right that is not held is not a change; newRoles = current roles is not either
    expect(
      proposalChanges(
        proposal({ newRoles: roles, featuredAppRightChange: { tag: 'FeaturedRight_Clear' } }),
        config,
      ),
    ).toEqual([])
    expect(
      proposalChanges(
        proposal({ featuredAppRightChange: { tag: 'FeaturedRight_Clear', value: {} } }),
        { ...config, featuredAppRight: 'right-0' },
      ),
    ).toEqual([{ scope: 'featuredAppRight', target: null, field: '', from: 'right-0', to: null }])
  })

  it('GET /governance: changes and the approval threshold per item', async () => {
    const reader = {
      snapshot: async () => snapshot(),
      councils: async () => [
        { contractId: 'council-1', payload: { operator: d.operator, members: M, threshold: '2' } },
      ],
      proposals: async () => [
        {
          contractId: 'prop-1',
          payload: proposal({
            threshold: '3',
            newParams: { ...config.params, minLoan: '5' },
          }),
        },
      ],
      rotations: async () => [
        {
          contractId: 'rot-1',
          payload: {
            operator: d.operator,
            members: M,
            threshold: '2',
            rotationId: 'r1',
            proposer: M[0],
            newMembers: M,
            newThreshold: '3',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            approvals: [],
            joined: [],
          },
        },
      ],
      incomeProposals: async () => [
        {
          contractId: 'inc-1',
          payload: {
            operator: d.operator,
            members: M,
            threshold: '2',
            proposalId: 'i1',
            proposer: M[0],
            treasury: d.treasury,
            reservesAmount: '1',
            collateral: [],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            approvals: [],
          },
        },
      ],
    } as unknown as Reader
    const v = await createGovernance(d, reader, registry()).view()
    expect(v.proposals[0]).toMatchObject({
      contractId: 'prop-1',
      threshold: 3,
      changes: [{ scope: 'protocol', target: null, field: 'minLoan', from: '1', to: '5' }],
    })
    expect(v.rotations[0]).toMatchObject({ threshold: 2, newThreshold: 3 })
    expect(v.income[0]).toMatchObject({ threshold: 2 })
  })
})

// ------------------------------------------------------------ council demo parties

const deployment = {
  operator: p('Operator'),
  oracle: p('Oracle'),
  guardian: p('Guardian'),
  treasury: p('Treasury'),
  backstop: p('Backstop'),
  liquidator: p('Liquidator'),
  alice: p('Alice'),
  testers: [p('Tester1')],
  council: M,
  usdcx: { admin: p('Usdcx'), id: 'USDCx' },
  cc: { admin: p('Cc'), id: 'CC' },
  cbtc: { admin: p('Cbtc'), id: 'CBTC' },
}

describe('deployment.json council', () => {
  it('deployment.json without council still parses (older deploys)', () => {
    const old: Partial<typeof deployment> = { ...deployment }
    delete old.council
    expect(deploymentSchema.parse(old).council).toEqual([])
    expect(deploymentSchema.parse(deployment).council).toEqual(M)
  })
})

// ------------------------------------------------------------ CORS by default

describe('CORS_ORIGIN defaults', () => {
  it('nothing by default, the value comes from the environment', () => {
    const devnet = { LEDGER_NETWORK: 'devnet', AUTH_SECRET: 'x'.repeat(40) }
    expect(loadConfig(devnet).CORS_ORIGIN).toBe('')
    expect(corsOrigins('')).toEqual([])
    expect(loadConfig({ ...devnet, CORS_ORIGIN: 'https://lending.example/' }).CORS_ORIGIN).toBe(
      'https://lending.example/',
    )
    expect(corsOrigins('https://a.example/, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('the preflight answers the configured origins and no other', async () => {
    const path = join(tmpdir(), `deployment-cors-${process.pid}.json`)
    writeFileSync(path, JSON.stringify(deployment))
    const a = await buildApp(
      loadConfig({
        LEDGER_API_URL: 'http://127.0.0.1:9',
        DEPLOYMENT_PATH: path,
        DATABASE_PATH: ':memory:',
        CORS_ORIGIN: 'http://localhost:5173,http://127.0.0.1:5173',
      }),
    )
    try {
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
        const r = await a.inject({
          method: 'OPTIONS',
          url: '/config',
          headers: { origin, 'access-control-request-method': 'POST' },
        })
        expect(r.headers['access-control-allow-origin']).toBe(origin)
      }
      const evil = await a.inject({
        method: 'OPTIONS',
        url: '/config',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      })
      expect(evil.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await a.close()
    }
  })
})
