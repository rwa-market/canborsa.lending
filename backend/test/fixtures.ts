/** Fixtures for remaining audit tests: pool snapshot, account, registry, ledgerless reader. */
import type { FastifyBaseLogger } from 'fastify'
import type { Deployment } from '../src/deployment.ts'
import type { Reader, Snapshot } from '../src/protocol/reader.ts'
import type { TokenRegistry } from '../src/protocol/registry.ts'
import type { Roles } from '../src/protocol/types.ts'

export const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger
export const p = (n: string) => `${n}::1220abcdef0123456789`
export const d = {
  operator: p('Operator'),
  oracle: p('Oracle'),
  guardian: p('Guardian'),
  treasury: p('Treasury'),
  backstop: p('Backstop'),
  liquidator: p('Liquidator'),
  alice: p('Alice'),
  testers: [],
  usdcx: { admin: p('Usdcx'), id: 'USDCx' },
  cc: { admin: p('Dso'), id: 'Amulet' },
  cbtc: { admin: p('Cbtc'), id: 'CBTC' },
} as unknown as Deployment
export const roles: Roles = {
  operator: d.operator,
  oracle: d.oracle,
  guardian: d.guardian,
  treasury: d.treasury,
  backstop: d.backstop,
  liquidators: [d.liquidator],
}

const nowIso = () => new Date().toISOString()
const feed = (cid: string, instrumentId: unknown, price: string) => ({
  contractId: cid,
  templateId: 'x:Lending.Oracle:PriceFeed',
  createdEventBlob: 'blob',
  synchronizerId: 'sync',
  payload: {
    oracle: d.oracle,
    instrumentId,
    quotes: [
      { source: 'a', price, observedAt: nowIso() },
      { source: 'b', price, observedAt: nowIso() },
    ],
    observers: [d.operator],
  },
})

export const zeroRates = {
  baseRate: '0',
  slope1: '0',
  slope2: '0',
  optimalUtilization: '0.8',
  maxUtilization: '0.9',
  reserveFactor: '0',
}

export function snapshot(over: { rateModel?: typeof zeroRates; lastUpdate?: string } = {}) {
  const params = {
    debtInstrument: d.usdcx,
    rateModel: over.rateModel ?? zeroRates,
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
  const market = {
    totalCollateral: '10000',
    protocolCollateral: '0',
    protocolCollateralBasis: '0',
  }
  return {
    config: {
      contractId: 'cfg',
      templateId: 'x:Lending.Config:ProtocolConfig',
      createdEventBlob: 'cfg-blob',
      synchronizerId: 'sync',
      payload: {
        roles,
        governors: [],
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
        governors: [],
        markets: [['CC', market]],
        state: {
          totalSupplyPrincipal: '100000',
          totalBorrowPrincipal: '50000',
          supplyIndex: '1',
          borrowIndex: '1',
          cash: '50000',
          lastUpdate: over.lastUpdate ?? nowIso(),
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
    markets: new Map([['CC', market]]),
    marketParams: new Map([['CC', ccParams]]),
    feeds: [feed('feed-usdcx', d.usdcx, '1'), feed('feed-cc', d.cc, '0.2')],
    attestations: [],
    featuredAppRight: null,
  } as unknown as Snapshot
}

/** Account with a signed principal (positive: deposit, negative: debt) and 10 000 CC. */
export const account = (principal = '-500', collateral = '10000') => ({
  contractId: 'acc',
  templateId: 'x:Lending.Account:Account',
  createdEventBlob: 'b',
  synchronizerId: 'sync',
  payload: {
    operator: d.operator,
    owner: d.alice,
    principal,
    collateral: [['CC', collateral]],
  },
})

export const holding = (cid: string, owner: string, amount: string, instrumentId: unknown) => ({
  contract: { contractId: cid, templateId: 'h', createdEventBlob: 'b', synchronizerId: 's' },
  view: { owner, amount, instrumentId, lock: null },
})

export const registry = (calls: unknown[] = []): TokenRegistry => ({
  transferFactory: async (_i, cid, intent) => {
    calls.push(intent)
    return {
      factoryCid: cid,
      disclosed: [],
      transferExtraArgs: { context: { values: {} }, meta: { values: {} } },
      acceptExtraArgs: { context: { values: {} }, meta: { values: {} } },
    }
  },
})

export function readerWith(
  s: Snapshot,
  acc: ReturnType<typeof account> | null,
  holdings: Record<string, ReturnType<typeof holding>[]> = {},
) {
  return {
    snapshot: async () => s,
    cachedSnapshot: async () => s,
    account: async () => acc,
    cachedAccount: async () => acc,
    roles: async () => roles,
    holdings: async (party: string) =>
      holdings[party] ??
      (party === d.operator
        ? [0, 1, 2].map((i) => holding(`op-${i}`, d.operator, '100000', d.usdcx))
        : []),
  } as unknown as Reader
}
