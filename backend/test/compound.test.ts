/**
 * Compound V3 model on the backend (Б1–Б6): the numbers of the control examples 1, 3, 4, 5 and 8
 * (docs/requirements/compound-v3-migration), the commands the wallet signs and the absorb bot.
 * Prices as in Env.daml: CC $0.20, CBTC $100 000, USDCx $1; default parameters.
 */
import { describe, expect, it } from 'vitest'
import { absorbable, createAbsorbBots } from '../src/bots/absorb.ts'
import type { Deployment } from '../src/deployment.ts'
import { CommandError, createCommandBuilder } from '../src/protocol/commands.ts'
import { preview } from '../src/protocol/preview.ts'
import type { Reader, Snapshot } from '../src/protocol/reader.ts'
import type { AccountPayload } from '../src/protocol/types.ts'
import { accountView, poolView, quoteCollateral, saleView } from '../src/protocol/views.ts'
import { holding, log, p, registry, roles } from './fixtures.ts'

const d = {
  operator: p('Operator'),
  oracle: p('Oracle'),
  guardian: p('Guardian'),
  treasury: p('Treasury'),
  backstop: p('Backstop'),
  liquidator: p('Liquidator'),
  alice: p('Alice'),
  testers: [],
  usdcx: { admin: p('Usdcx'), id: 'USDCx' },
  cc: { admin: p('Cc'), id: 'CC' },
  cbtc: { admin: p('Cbtc'), id: 'CBTC' },
} as unknown as Deployment

const now = new Date()
const iso = (t: Date) => t.toISOString()
const contract = <T>(contractId: string, payload: T) => ({
  contractId,
  templateId: `x:${contractId}`,
  createdEventBlob: `${contractId}-blob`,
  synchronizerId: 'sync',
  payload,
})
const feed = (instrumentId: { admin: string; id: string }, price: string, at = now) =>
  contract(`feed-${instrumentId.id}`, {
    oracle: d.oracle,
    instrumentId,
    observers: [d.operator],
    quotes: [
      { source: 'a', price, observedAt: iso(at) },
      { source: 'b', price, observedAt: iso(at) },
    ],
  })

const ccParams = {
  collateralInstrument: d.cc,
  borrowCollateralFactor: '0.3',
  liquidateCollateralFactor: '0.45',
  liquidationFactor: '0.93',
  supplyCap: '400000',
  minCollateralAmount: '10',
  requiresReserveAttestation: false,
  minReserveCoverage: '1',
  maxAttestationAgeSeconds: '86400',
}
const cbtcParams = {
  ...ccParams,
  collateralInstrument: d.cbtc,
  borrowCollateralFactor: '0.5',
  liquidateCollateralFactor: '0.65',
  liquidationFactor: '0.95',
  supplyCap: '0.58',
  minCollateralAmount: '0.00001',
  requiresReserveAttestation: true,
}

interface World {
  ccPrice?: string
  cbtcStale?: boolean
  supply?: string
  debt?: string
  cash?: string
  stock?: string
  cbtcStock?: string
  basis?: string
  pause?: Partial<Record<string, boolean>>
}

function world(w: World = {}): Snapshot {
  const params = {
    debtInstrument: d.usdcx,
    rateModel: {
      baseRate: '0.02',
      slope1: '0.08',
      slope2: '0.6',
      optimalUtilization: '0.65',
      maxUtilization: '0.8',
      reserveFactor: '0.2',
    },
    totalBorrowCap: '50000',
    maxDebtPerUser: '5000',
    minLoan: '250',
    liquidationRiskWarning: '0.71',
    maxPriceAgeSeconds: '300',
    maxSourceDeviation: '0.03',
    maxLiquidationSourceDeviation: '0.15',
    maxDebtDepeg: '0.02',
    maxClockSkewSeconds: '60',
    storeFrontPriceFactor: '0.8',
    targetReserves: '50000',
  }
  const markets: [string, unknown][] = [
    [
      'CC',
      {
        totalCollateral: '70000',
        protocolCollateral: w.stock ?? '0',
        protocolCollateralBasis: w.basis ?? '0',
      },
    ],
    [
      'CBTC',
      {
        totalCollateral: '0.1',
        protocolCollateral: w.cbtcStock ?? '0',
        protocolCollateralBasis: w.cbtcStock ? '1' : '0',
      },
    ],
  ]
  return {
    config: contract('cfg', {
      roles,
      governors: [],
      params,
      marketParams: [
        ['CC', ccParams],
        ['CBTC', cbtcParams],
      ],
      transferFactories: [
        [d.usdcx, 'f-usdcx'],
        [d.cc, 'f-cc'],
        [d.cbtc, 'f-cbtc'],
      ],
    }),
    pool: contract('pool', {
      operator: d.operator,
      governors: [],
      markets,
      state: {
        totalSupplyPrincipal: w.supply ?? '20000',
        totalBorrowPrincipal: w.debt ?? '0',
        supplyIndex: '1',
        borrowIndex: '1',
        cash: w.cash ?? '20000',
        lastUpdate: iso(now),
      },
    }),
    pause: contract('pause', {
      operator: d.operator,
      guardian: d.guardian,
      flags: {
        borrowPaused: false,
        collateralWithdrawPaused: false,
        supplyWithdrawPaused: false,
        absorbPaused: false,
        buyPaused: false,
        ...w.pause,
      },
    }),
    markets: new Map(markets as never),
    marketParams: new Map([
      ['CC', ccParams],
      ['CBTC', cbtcParams],
    ]),
    feeds: [
      feed(d.usdcx, '1'),
      feed(d.cc, w.ccPrice ?? '0.2'),
      feed(d.cbtc, '100000', w.cbtcStale ? new Date(now.getTime() - 301_000) : now),
    ],
    attestations: [
      contract('att-cbtc', {
        oracle: d.oracle,
        instrumentId: d.cbtc,
        coverage: '1',
        attestedAt: iso(now),
        observers: [d.operator],
      }),
    ],
    featuredAppRight: null,
  } as unknown as Snapshot
}

const acct = (principal: string, collateral: [string, string][]): AccountPayload => ({
  operator: d.operator,
  owner: d.alice!,
  principal,
  collateral,
})
const both: [string, string][] = [
  ['CC', '20000'],
  ['CBTC', '0.1'],
]

describe('Б1: account summary (control example 1)', () => {
  it('collateral 14 000, capacity 6 200, point 8 300; risk 60.24% at a 5 000 debt', () => {
    const v = accountView(
      d,
      world({ debt: '5000', cash: '15000' }),
      contract('acc', acct('-5000', both)),
      now,
    )!
    expect(v.summary.collateralValueUsd).toBe('14000.0000000000')
    expect(v.summary.borrowCapacityUsd).toBe('6200.0000000000')
    expect(v.summary.liquidationPointUsd).toBe('8300.0000000000')
    expect(v.summary.liquidationRisk).toBe('0.602410')
    expect(v.summary.balance).toBe('-5000.0000000000')
    expect(v.summary.borrowed).toBe('5000.0000000000')
    // capacity 1 200 more, but the per-user cap is already reached
    expect(v.summary.availableToBorrow).toBe('0.0000000000')
    expect(v.summary.status).toBe('healthy')
    expect(v.summary.absorbPenaltyUsd).toBe('780.0000000000')
    expect(v.summary.maxBorrow).toBe('0.0000000000')
  })

  it('review 08.10, item 3: Borrow pays the deposit first, so its Max is deposit + new debt', () => {
    const v = accountView(d, world({ cash: '15000' }), contract('acc', acct('950', both)), now)!
    expect(v.summary.availableToBorrow).toBe('5000.0000000000')
    expect(v.summary.maxBorrow).toBe('5950.0000000000')
    // the pool cash bounds it: a thin pool pays out no more than it holds
    const thin = accountView(d, world({ cash: '3000' }), contract('acc', acct('950', both)), now)!
    expect(thin.summary.maxBorrow).toBe('3000.0000000000')
  })

  it('Max passes the preview when the utilization ceiling binds: the deposit leaves the supply', () => {
    // supply 20 000, debt 14 000: after the 950 deposit leaves, 80 % × 19 050 − 14 000 = 1 240
    const s = world({ supply: '20000', debt: '14000', cash: '6000' })
    const a = acct('950', both)
    const v = accountView(d, s, contract('acc', a), now)!
    expect(v.summary.availableToBorrow).toBe('1240.0000000000')
    expect(v.summary.maxBorrow).toBe('2190.0000000000')
    expect(preview(d, s, a, 'borrow', '2190', undefined, now).blockers).toEqual([])
    expect(preview(d, s, a, 'borrow', '2190.0000000001', undefined, now).blockers).toContainEqual(
      expect.stringMatching(/utilization/),
    )
  })

  it('new debt under the minimum loan is not offered: Max is the deposit alone', () => {
    // 80 % × 19 050 − 15 000 = 240 USDCx of new debt, under minLoan 250
    const s = world({ supply: '20000', debt: '15000', cash: '5000' })
    const a = acct('950', both)
    const v = accountView(d, s, contract('acc', a), now)!
    expect(v.summary.availableToBorrow).toBe('240.0000000000')
    expect(v.summary.maxBorrow).toBe('950.0000000000')
    expect(preview(d, s, a, 'borrow', '950', undefined, now).blockers).toEqual([])
  })
})

describe('Б5: preview', () => {
  it('example 1: 5 001 is above the per-user cap, 5 000 passes', () => {
    const s = world()
    const a = acct('0', both)
    expect(preview(d, s, a, 'borrow', '5001', undefined, now).blockers).toContain(
      'Debt per user is capped at 5,000 USDCx',
    )
    const ok = preview(d, s, a, 'borrow', '5000', undefined, now)
    expect(ok.blockers).toEqual([])
    expect(ok.after?.liquidationRisk).toBe('0.602410')
    expect(ok.after?.balance).toBe('-5000.0000000000')
  })

  it('example 3: a withdrawal never borrows; the debt after a borrow is at least 250', () => {
    const s = world()
    const a = acct('500', both)
    expect(preview(d, s, a, 'withdraw', '600', undefined, now).blockers[0]).toMatch(/use Borrow/)
    expect(preview(d, s, a, 'borrow', '600', undefined, now).blockers[0]).toMatch(
      /Debt after the loan would be 100 USDCx; the minimum loan is 250 USDCx/,
    )
    const ok = preview(d, s, a, 'borrow', '800', undefined, now)
    expect(ok.blockers).toEqual([])
    expect(ok.after?.balance).toBe('-300.0000000000')
  })

  it('example 8: a stale CBTC price leaves only the CC capacity of 1 200', () => {
    const s = world({ cbtcStale: true })
    const a = acct('0', both)
    expect(preview(d, s, a, 'borrow', '1300', undefined, now).blockers).toContain(
      'Not enough collateral: borrow capacity is $1,200',
    )
    const ok = preview(d, s, a, 'borrow', '1000', undefined, now)
    expect(ok.blockers).toEqual([])
    expect(ok.warnings[0]).toMatch(/CBTC has no valid price/)
  })

  it('supply repays the debt first (example 2)', () => {
    const r = preview(
      d,
      world({ debt: '1000' }),
      acct('-1000', both),
      'supply',
      '1500',
      undefined,
      now,
    )
    expect(r.repaysDebt).toBe('1000.0000000000')
    expect(r.after?.balance).toBe('500.0000000000')
    expect(r.warnings[0]).toMatch(/500 USDCx becomes your deposit/)
  })

  it('repay all is exactly the debt; withdraw all exactly the deposit', () => {
    const r = preview(
      d,
      world({ debt: '1000' }),
      acct('-1000', both),
      'repay',
      'max',
      undefined,
      now,
    )
    expect(r.amount).toBe('1000.0000000000')
    expect(r.after?.balance).toBe('0.0000000000')
    const w = preview(d, world(), acct('500', both), 'withdraw', 'max', undefined, now)
    expect(w.amount).toBe('500.0000000000')
  })

  it('collateral: the minimum deposit and the supply cap in asset units', () => {
    const s = world()
    expect(preview(d, s, acct('0', []), 'deposit-collateral', '9', 'CC', now).blockers[0]).toMatch(
      /Minimum deposit is 10 CC/,
    )
    // review 08.10, item 4: a small minimum is shown as it is, not rounded to 0
    expect(
      preview(d, s, acct('0', []), 'deposit-collateral', '0.000001', 'CBTC', now).blockers[0],
    ).toBe('Minimum deposit is 0.00001 CBTC')
    // a minimum is never shown lower than it is
    expect(preview(d, s, acct('0', []), 'deposit-collateral', '9', 'CC', now).blockers[0]).toBe(
      'Minimum deposit is 10 CC',
    )
    expect(
      preview(d, s, acct('0', []), 'deposit-collateral', '0.00001', 'CBTC', now).blockers,
    ).not.toContainEqual(expect.stringMatching(/Minimum/))
    // the cap is 0.58 CBTC, 0.1 is already in: exactly 0.48 fits, one step more does not
    expect(
      preview(d, s, acct('0', []), 'deposit-collateral', '0.48', 'CBTC', now).blockers,
    ).toEqual([])
    expect(
      preview(d, s, acct('0', []), 'deposit-collateral', '0.4800000001', 'CBTC', now).blockers[0],
    ).toMatch(/supply cap/)
  })

  it('pauses close their own operation only', () => {
    const s = world({
      pause: { borrowPaused: true, supplyWithdrawPaused: true, collateralWithdrawPaused: true },
    })
    expect(preview(d, s, acct('0', both), 'borrow', '300', undefined, now).blockers).toContain(
      'Borrowing is paused',
    )
    expect(preview(d, s, acct('500', both), 'withdraw', '10', undefined, now).blockers).toContain(
      'Deposit withdrawals are paused',
    )
    expect(
      preview(d, s, acct('0', both), 'withdraw-collateral', '10', 'CC', now).blockers,
    ).toContain('Collateral withdrawals are paused')
    expect(preview(d, s, acct('-500', both), 'supply', '100', undefined, now).blockers).toEqual([])
    expect(preview(d, s, acct('0', both), 'deposit-collateral', '100', 'CC', now).blockers).toEqual(
      [],
    )
  })
})

describe('Б2: pool view', () => {
  it('reserves = cash + debt − supply, net reserves add the book value (example 7)', () => {
    // supply 20 000, debt 0, cash 13 955: reserves −6 045; stock 50 000 CC booked at 6 045
    const v = poolView(d, world({ cash: '13955', stock: '50000', basis: '6045' }), now)
    expect(v.reserves).toBe('-6045.0000000000')
    expect(v.netReserves).toBe('0.0000000000')
    expect(v.collateralForSale).toBe(true)
    expect(v.markets[0]!.liquidationPenalty).toBe('0.070000')
    expect(v.markets[0]!.purchaseDiscount).toBe('0.056000')
    expect(v.borrowApr).toBe('0.020000')
  })
})

describe('market page totals', () => {
  // collateral 70 000 CC at $0.2 + 0.1 CBTC at $100 000 = $24 000
  it('collateral value, liquidity under the 80% ceiling, collateralization', () => {
    const v = poolView(d, world({ supply: '20000', debt: '12000', cash: '8000' }), now)
    expect(v.totalCollateralUsd).toBe('24000.0000000000')
    // cash 8 000, ceiling 0.8 × 20 000 − 12 000 = 4 000, cap 50 000 − 12 000
    expect(v.availableLiquidity).toBe('4000.0000000000')
    expect(v.collateralization).toBe('2.000000')
  })

  it('cash is the limit when it is below the ceiling; no debt: no collateralization', () => {
    const v = poolView(d, world({ supply: '20000', debt: '0', cash: '3000' }), now)
    expect(v.availableLiquidity).toBe('3000.0000000000')
    expect(v.collateralization).toBeNull()
  })

  it('never negative: a pool above its ceiling lends nothing', () => {
    const v = poolView(d, world({ supply: '10000', debt: '9000', cash: '5000' }), now)
    expect(v.availableLiquidity).toBe('0.0000000000')
  })
})

describe('Б6: absorb and purchase', () => {
  it('example 4: absorbable at $0.13, not at $0.134', () => {
    const a = acct('-3000', [['CC', '50000']])
    expect(absorbable(world({ ccPrice: '0.13', debt: '3000' }), d, a, now)).toBe(true)
    expect(absorbable(world({ ccPrice: '0.134', debt: '3000' }), d, a, now)).toBe(false)
    expect(
      absorbable(world({ ccPrice: '0.13', debt: '3000' }), d, acct('100', [['CC', '50000']]), now),
    ).toBe(false)
  })

  it('example 8: absorb is impossible while a price is stale', () => {
    expect(
      absorbable(world({ cbtcStale: true, ccPrice: '0.01' }), d, acct('-1000', both), now),
    ).toBeNull()
  })

  it('example 5: 6 136 USDCx buy exactly 50 000 CC at 0.12272', () => {
    const sale = saleView(world({ ccPrice: '0.13', stock: '50000', basis: '6045' }), d, 'CC', now)!
    expect(sale.price).toBe('0.12272')
    expect(quoteCollateral(sale, '6136')).toBe('50000.0000000000')
  })

  it('the absorb bot submits Pool_Absorb for absorbable accounts only', async () => {
    const s = world({ ccPrice: '0.13', debt: '3000' })
    const accounts = [
      contract('bad', acct('-3000', [['CC', '50000']])),
      contract('good', acct('-100', [['CC', '50000']])),
    ]
    const submitted: { commands: unknown[]; commandId: string | undefined }[] = []
    const ledger = {
      submit: async (
        _a: string[],
        commands: unknown[],
        _d: unknown,
        _r: unknown,
        o: { commandId?: string },
      ) => {
        submitted.push({ commands, commandId: o.commandId })
        return { updateId: 'u', events: [] }
      },
    }
    const reader = { snapshot: async () => s, accounts: async () => accounts } as unknown as Reader
    const commands = createCommandBuilder(d, reader, registry())
    const bots = createAbsorbBots(ledger as never, reader, commands, d, log)
    await bots.absorber()
    expect(submitted).toHaveLength(1)
    const ex = (
      submitted[0]!.commands[0] as {
        ExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> }
      }
    ).ExerciseCommand
    expect(ex.choice).toBe('Pool_Absorb')
    expect(ex.choiceArgument.accountCid).toBe('bad')
    expect(ex.choiceArgument.pauseCid).toBe('pause')
    expect(submitted[0]!.commandId).toMatch(/^absorb-/)
  })

  it('the absorb bot waits while absorb is paused', async () => {
    const s = world({ ccPrice: '0.13', debt: '3000', pause: { absorbPaused: true } })
    const submitted: unknown[] = []
    const ledger = { submit: async () => submitted.push(1) }
    const reader = {
      snapshot: async () => s,
      accounts: async () => [contract('bad', acct('-3000', [['CC', '50000']]))],
    } as unknown as Reader
    await createAbsorbBots(
      ledger as never,
      reader,
      createCommandBuilder(d, reader, registry()),
      d,
      log,
    ).absorber()
    expect(submitted).toHaveLength(0)
  })
})

describe('Б4: commands', () => {
  const arg = (cmd: { commands: unknown[] }) =>
    (
      cmd.commands[0] as {
        ExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> }
      }
    ).ExerciseCommand
  const readerFor = (
    s: Snapshot,
    a: AccountPayload,
    holdings: Record<string, ReturnType<typeof holding>[]> = {},
  ) =>
    ({
      snapshot: async () => s,
      account: async () => contract('acc', a),
      holdings: async (party: string, instrument: { id: string }) =>
        holdings[party] ??
        (party === d.operator
          ? [
              holding('op-usdcx', d.operator, '100000', d.usdcx),
              holding('op-cc', d.operator, '100000', d.cc),
            ].filter((h) => (h.view.instrumentId as { id: string }).id === instrument.id)
          : [holding('u-1', party, '100000', instrument)]),
    }) as unknown as Reader

  it('withdraw never borrows: allowBorrow = false and no prices', async () => {
    const c = createCommandBuilder(d, readerFor(world(), acct('500', both)), registry())
    const e = arg(await c.withdraw(d.alice!, '100'))
    expect(e.choice).toBe('Pool_WithdrawBase')
    expect(e.choiceArgument.allowBorrow).toBe(false)
    expect(e.choiceArgument.full).toBe(false)
    expect(e.choiceArgument.pauseCid).toBe('pause')
    await expect(c.withdraw(d.alice!, '600')).rejects.toThrow(/use Borrow/)
  })

  it('borrow: allowBorrow = true with every collateral feed, the USDCx feed and the CBTC attestation', async () => {
    const c = createCommandBuilder(d, readerFor(world(), acct('0', both)), registry())
    const cmd = await c.borrow(d.alice!, '1000')
    const e = arg(cmd)
    expect(e.choiceArgument.allowBorrow).toBe(true)
    expect(e.choiceArgument.prices).toEqual({
      collateralFeedCids: ['feed-CC', 'feed-CBTC'],
      debtFeedCid: 'feed-USDCx',
      attestationCids: ['att-cbtc'],
    })
    const disclosed = cmd.disclosedContracts.map((x) => x.contractId)
    expect(disclosed).toEqual(
      expect.arrayContaining(['pool', 'cfg', 'pause', 'feed-CC', 'feed-CBTC', 'att-cbtc']),
    )
    await expect(c.borrow(d.alice!, '6201')).rejects.toBeInstanceOf(CommandError)
  })

  it('repay all: Pool_SupplyBase with full = true and the debt as the cap', async () => {
    const c = createCommandBuilder(
      d,
      readerFor(world({ debt: '1000' }), acct('-1000', both)),
      registry(),
    )
    const e = arg(await c.repay(d.alice!, 'max'))
    expect(e.choice).toBe('Pool_SupplyBase')
    expect(e.choiceArgument.full).toBe(true)
    // the cap is the debt at the signing deadline: 15 minutes of interest above 1 000
    expect(e.choiceArgument.amount).toMatch(/^1000\.000\d+$/)
    await expect(
      createCommandBuilder(d, readerFor(world(), acct('500', both)), registry()).repay(
        d.alice!,
        'max',
      ),
    ).rejects.toThrow(/No debt/)
  })

  it('buy: only an approved buyer, never below the minimum to receive', async () => {
    const s = world({ ccPrice: '0.13', stock: '50000', basis: '6045' })
    const c = createCommandBuilder(d, readerFor(s, acct('0', [])), registry())
    await expect(c.buyCollateral(d.alice!, 'CC', '6136', '0')).rejects.toThrow(/approved buyer/)
    await expect(c.buyCollateral(d.liquidator, 'CC', '6136', '50001')).rejects.toThrow(
      /less than the minimum/,
    )
    const e = arg(await c.buyCollateral(d.liquidator, 'CC', '6136', '50000'))
    expect(e.choice).toBe('Pool_BuyCollateral')
    expect(e.choiceArgument).toMatchObject({
      buyer: d.liquidator,
      marketId: 'CC',
      amount: '6136',
      minCollateral: '50000',
    })
  })

  it('the buyer bot pays the whole cost of a cheap stock; a partial buy under 1 USDCx waits', async () => {
    const bought = async (stock: string, usdcx: string) => {
      const s = world({ ccPrice: '0.13', stock, basis: '0.0000000002' })
      const submitted: Record<string, unknown>[] = []
      const ledger = {
        submit: async (_a: string[], commands: unknown[]) => {
          submitted.push(
            (commands[0] as { ExerciseCommand: { choiceArgument: Record<string, unknown> } })
              .ExerciseCommand.choiceArgument,
          )
          return { updateId: 'u', events: [] }
        },
      }
      const reader = readerFor(s, acct('0', []), {
        [d.liquidator]: [holding('l-1', d.liquidator, usdcx, d.usdcx)],
      })
      await createAbsorbBots(
        ledger as never,
        reader,
        createCommandBuilder(d, reader, registry()),
        d,
        log,
      ).liquidator()
      return submitted
    }
    // 0.0000000013 CC at 0.12272 costs 0.00000000016 USDCx: the bot pays the cost rounded up
    expect(await bought('0.0000000013', '100')).toMatchObject([{ amount: '0.0000000002' }])
    // 5 CC cost 0.61 USDCx: the whole stock, bought too
    expect(await bought('5', '100')).toMatchObject([{ amount: '0.6136000000' }])
    // 50 000 CC with 0.5 USDCx in the wallet: a partial buy under 1 USDCx waits
    expect(await bought('50000', '0.5')).toEqual([])
  })

  it('pause: one flag for the guardian (PauseState_SetFlag), the pool untouched', async () => {
    const c = createCommandBuilder(d, readerFor(world(), acct('0', [])), registry())
    const cmd = await c.setPause('borrowPaused', true)
    expect(cmd.actAs).toEqual([d.guardian])
    expect(arg(cmd).choice).toBe('PauseState_SetFlag')
    expect(arg(cmd).choiceArgument).toEqual({ flag: 'BorrowFlag', paused: true })
  })
})

describe('Б6: readiness signals of the absorb bots', () => {
  const quiet = { submit: async () => ({ updateId: 'u', events: [] }) }
  const bots = (
    s: Snapshot,
    accounts: unknown[],
    ledger: unknown = quiet,
    clock = { t: now.getTime() },
  ) => {
    const reader = {
      snapshot: async () => s,
      accounts: async () => accounts,
      holdings: async () => [holding('h', d.liquidator, '100000', d.usdcx)],
    } as unknown as Reader
    return createAbsorbBots(
      ledger as never,
      reader,
      createCommandBuilder(d, reader, registry()),
      d,
      log,
      {
        absorbAlertMs: 1000,
        stockAlertMs: 1000,
        now: () => clock.t,
      },
    )
  }

  it('risk 4: a debt that cannot be valued becomes a signal after the alert time, not before', async () => {
    const clock = { t: now.getTime() }
    const b = bots(
      world({ cbtcStale: true, debt: '1000' }),
      [contract('a', acct('-1000', both))],
      quiet,
      clock,
    )
    await b.absorber()
    expect((await b.signals()).unpricedDebt).toBe(0)
    clock.t += 1000
    expect((await b.signals()).unpricedDebt).toBe(0)
    clock.t += 1
    expect((await b.signals()).unpricedDebt).toBe(1)
  })

  it('an absorb rejected for a reason other than contention fails the step', async () => {
    const rejecting = {
      submit: async () => {
        throw new Error('FAILED_PRECONDITION: account is not liquidatable')
      },
    }
    const b = bots(
      world({ ccPrice: '0.13', debt: '3000' }),
      [contract('bad', acct('-3000', [['CC', '50000']]))],
      rejecting,
    )
    await expect(b.absorber()).rejects.toThrow(/absorb rejected 1 time/)
  })

  it('a buyer rotated out of ProtocolConfig fails loudly instead of buying', async () => {
    const s = world({ ccPrice: '0.13', stock: '50000', basis: '6045' })
    ;(s.config.payload as { roles: unknown }).roles = { ...roles, liquidators: [p('Other')] }
    await expect(bots(s, []).liquidator()).rejects.toThrow(/no longer an approved buyer/)
  })

  it('no stock or buyer alarm while reserves are at the target: the sale is closed by design', async () => {
    const clock = { t: now.getTime() }
    // supply 20 000, cash 70 000: reserves 50 000 = target
    const b = bots(world({ cash: '70000', stock: '50000', basis: '6045' }), [], quiet, clock)
    await b.signals()
    clock.t += 2000
    const sig = await b.signals()
    expect(sig.staleStock).toEqual([])
    expect(sig.buyersShort).toBe(false)
  })

  it('stock waiting while the sale is open is an alarm after the alert time', async () => {
    const clock = { t: now.getTime() }
    const b = bots(world({ cash: '13955', stock: '50000', basis: '6045' }), [], quiet, clock)
    await b.signals()
    clock.t += 2000
    expect((await b.signals()).staleStock).toEqual(['CC'])
  })
})

describe('account status', () => {
  it('a debt without a usable price is unknown, not healthy', () => {
    const v = accountView(
      d,
      world({ cbtcStale: true, debt: '1000', cash: '19000' }),
      contract('acc', acct('-1000', both)),
      now,
    )!
    expect(v.summary.status).toBe('unknown')
    expect(v.summary.liquidationRisk).toBeNull()
  })
})

describe('1.0.2: whole-stock purchases (audit: a CBTC rest of one token unit)', () => {
  // CBTC at $100 000 sells at 96 000: 0.0123456789 CBTC cost 1 185.1851744 USDCx
  const s = () => world({ cash: '13955', cbtcStock: '0.0123456789' })

  it('paying the whole cost quotes the whole stock; a unit less leaves a rest', () => {
    const sale = saleView(s(), d, 'CBTC', now)!
    expect(sale.costOfAll).toBe('1185.1851744000')
    expect(quoteCollateral(sale, sale.costOfAll!)).toBe('0.0123456789')
    expect(quoteCollateral(sale, '1185.1851743999')).toBe('0.0123456788')
  })

  it('the buyer bot pays the whole cost, so no rest is left', async () => {
    const submitted: Record<string, unknown>[] = []
    const ledger = {
      submit: async (_a: string[], commands: unknown[]) => {
        submitted.push(
          (commands[0] as { ExerciseCommand: { choiceArgument: Record<string, unknown> } })
            .ExerciseCommand.choiceArgument,
        )
        return { updateId: 'u', events: [] }
      },
    }
    const reader = {
      snapshot: async () => s(),
      holdings: async (party: string, instrument: { id: string }) =>
        party === d.operator
          ? [holding('op-cbtc', d.operator, '1', d.cbtc)].filter(
              (h) => (h.view.instrumentId as { id: string }).id === instrument.id,
            )
          : [holding('l-1', party, '5000', d.usdcx)],
    } as unknown as Reader
    await createAbsorbBots(
      ledger as never,
      reader,
      createCommandBuilder(d, reader, registry()),
      d,
      log,
    ).liquidator()
    expect(submitted).toMatchObject([
      { marketId: 'CBTC', amount: '1185.1851744000', minCollateral: '0.0120987653' },
    ])
  })

  it('commands refuse an overpayment and a partial buy under 1 USDCx', async () => {
    const reader = {
      snapshot: async () => s(),
      holdings: async (party: string) => [holding('l-1', party, '5000', d.usdcx)],
    } as unknown as Reader
    const c = createCommandBuilder(d, reader, registry())
    await expect(c.buyCollateral(d.liquidator, 'CBTC', '1185.1851744001', '0')).rejects.toThrow(
      /Everything for sale costs 1185.1851744000/,
    )
    await expect(c.buyCollateral(d.liquidator, 'CBTC', '0.5', '0')).rejects.toThrow(
      /at least 1 USDCx/,
    )
  })
})

describe('review 03.10, item 14: pause flags follow a new guardian', () => {
  it('the absorber rebinds the flags before anything else, once per pause contract', async () => {
    const s = world()
    ;(s.config.payload as { roles: unknown }).roles = { ...roles, guardian: p('NewGuardian') }
    const submitted: { commands: unknown[]; commandId?: string | undefined }[] = []
    const ledger = {
      submit: async (
        _a: string[],
        commands: unknown[],
        _d: unknown,
        _r: unknown,
        o: { commandId?: string },
      ) => {
        submitted.push({ commands, commandId: o.commandId })
        return { updateId: 'u', events: [] }
      },
    }
    const reader = { snapshot: async () => s, accounts: async () => [] } as unknown as Reader
    const r = await createAbsorbBots(
      ledger as never,
      reader,
      createCommandBuilder(d, reader, registry()),
      d,
      log,
    ).absorber()
    expect(r).toMatchObject({ rebound: true })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.commands[0]).toMatchObject({
      ExerciseCommand: {
        contractId: 'pause',
        choice: 'PauseState_Rebind',
        choiceArgument: { configCid: 'cfg' },
      },
    })
    expect(submitted[0]!.commandId).toMatch(/^pause-rebind-/)
  })
})

describe('control example 6 on the backend (review 03.10, item 20)', () => {
  // after the absorb: supply 20 000, Bob's debt 1 000, cash 16 500, stock 50 000 CC at book 2 325
  const s = () =>
    world({ supply: '20000', debt: '1000', cash: '16500', stock: '50000', basis: '2325' })

  it('net reserves −175: new loans and deposit withdrawals wait, supply and deposits do not', () => {
    const v = poolView(d, s(), now)
    expect(v.reserves).toBe('-2500.0000000000')
    expect(v.netReserves).toBe('-175.0000000000')
    const blockers = (a: AccountPayload, op: Parameters<typeof preview>[3], amount: string) =>
      preview(d, s(), a, op, amount, op === 'deposit-collateral' ? 'CC' : undefined, now).blockers
    expect(blockers(acct('-1000', both), 'borrow', '300').join()).toMatch(/Reserves are negative/)
    expect(blockers(acct('500', both), 'withdraw', '100').join()).toMatch(/Reserves are negative/)
    expect(blockers(acct('500', both), 'supply', '100')).toEqual([])
    expect(blockers(acct('-1000', both), 'repay', '100')).toEqual([])
    expect(blockers(acct('0', both), 'deposit-collateral', '100')).toEqual([])
  })
})
