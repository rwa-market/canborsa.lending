/**
 * Demo scenario of the Compound V3 model against the live DevNet stack (ADR-009, step 8):
 *
 *   pnpm --filter @lending/backend devnet:scenario
 *
 * Bob supplies CC and borrows close to his borrow capacity; the oracle party publishes CC at half
 * the price; the absorber bot of the running backend absorbs the account and the buyer bots buy the
 * stock. The script only acts as Bob and as the oracle and checks what the bots did; the next
 * oracle cycles put the market price back. DevNet only: it publishes a fake price.
 */
import { isPublicNetwork, loadConfig } from '../config.ts'
import { loadDeployment } from '../deployment.ts'
import { createRoleLedgers } from '../ledger/credentials.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import { createCommandBuilder, type PreparedCommand } from '../protocol/commands.ts'
import { Decimal } from 'decimal.js'
import { dec, midPrice, presentValue, type Dec } from '../protocol/math.ts'
import { createReader, feedFor } from '../protocol/reader.ts'
import { createRegistry } from '../protocol/registry.ts'

const config = loadConfig()
// A fake price absorbs every CC borrower: DevNet only, and stated explicitly (the network setting
// defaults to devnet, so a default must not be enough)
if (
  isPublicNetwork(config.LEDGER_NETWORK) ||
  process.env.LEDGER_NETWORK !== 'devnet' ||
  config.NETWORK_ID !== 'canton:devnet'
)
  throw new Error(
    'devnet-scenario publishes a fake price: set LEDGER_NETWORK=devnet and NETWORK_ID=canton:devnet',
  )
const d = loadDeployment(config.DEPLOYMENT_PATH)
const { ledger } = await createRoleLedgers(
  {
    LEDGER_API_URL: config.LEDGER_API_URL,
    LEDGER_PAGE_SIZE: config.LEDGER_PAGE_SIZE,
    LEDGER_MAX_PAGES: config.LEDGER_MAX_PAGES,
    credentials: config.credentials,
    publicNetwork: false,
  },
  d,
)
const reader = createReader(ledger, d)
const commands = createCommandBuilder(d, reader, createRegistry(config, ledger, d))
if (!d.bob || !d.alice) throw new Error('deployment.json has no bob and alice (deployDevnet)')
const user = d.bob
const alice = d.alice
const ccId = 'CC'

const run = async (label: string, p: PreparedCommand | Promise<PreparedCommand>) => {
  const c = await p
  const r = await ledger.submit(c.actAs, c.commands as never[], c.disclosedContracts as never[])
  console.log(`${label}: ${r.updateId}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(label: string, f: () => Promise<T | null>, timeoutMs: number) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await f()
    if (v !== null) return v
    if (Date.now() > until) throw new Error(`timeout: ${label}`)
    await sleep(3000)
  }
}
const balanceOf = async (party: string, instrument: { admin: string; id: string }) =>
  (await reader.holdings(party, instrument)).reduce((s, h) => s.plus(h.view.amount), dec(0))

async function mint(owner: string, instrument: { admin: string; id: string }, amount: Dec) {
  await ledger.submit(
    [instrument.admin, owner],
    [
      {
        CreateCommand: {
          templateId: TEMPLATES.testToken,
          createArguments: {
            holding: {
              owner,
              instrumentId: instrument,
              amount: amount.toFixed(10),
              lock: null,
              meta: { values: {} },
            },
          },
        },
      },
    ],
  )
}

async function ccMid() {
  const s = await reader.snapshot()
  const feed = feedFor(s, d.cc)
  if (!feed) throw new Error('no CC price feed')
  return { feed, mid: midPrice(feed.payload.quotes.map((q) => q.price)) }
}

// 1. Account and tokens
if (!(await reader.account(user))) {
  await run('account request', commands.openAccount(user))
  await waitFor('account opened by the accounts bot', () => reader.account(user), 120_000)
}
const s0 = await reader.snapshot()
const cc = s0.marketParams.get(ccId)!
const { mid } = await ccMid()
const idx = (st: typeof s0.pool.payload.state) => ({
  supplyIndex: dec(st.supplyIndex),
  borrowIndex: dec(st.borrowIndex),
})
// Idempotent: count what Bob already has. Collateral worth at least $2 000, debt 90% of the capacity
const a0 = (await reader.account(user))!
const held = dec(a0.payload.collateral.find(([m]) => m === ccId)?.[1] ?? 0)
const debt0 = presentValue(dec(a0.payload.principal), idx(s0.pool.payload.state)).neg()
const collateral = Decimal.max(held, dec(2000).div(mid).toDecimalPlaces(0, 0))
const deposit = collateral.minus(held)
const target = collateral.mul(mid).mul(cc.borrowCollateralFactor).mul(0.9).toDecimalPlaces(2, 1)
// a deposit is withdrawn first: the loan covers it and leaves the target debt
const loan = target.minus(debt0).toDecimalPlaces(2, 1)
console.log(
  `CC at ${mid}: Bob holds ${held} CC, owes ${debt0.toFixed(2)}; deposit ${deposit}, borrow ${loan}`,
)
if (deposit.gt(0) && (await balanceOf(user, d.cc)).lt(deposit)) await mint(user, d.cc, deposit)
// The utilization ceiling counts deposits, not reserves: the loan needs suppliers
const st = s0.pool.payload.state
const supplied = dec(st.totalSupplyPrincipal).mul(st.supplyIndex)
if (supplied.lt(target.mul(2))) {
  const supply = target.mul(4).toDecimalPlaces(0, 0)
  if ((await balanceOf(alice, d.usdcx)).lt(supply)) await mint(alice, d.usdcx, supply)
  if (!(await reader.account(alice))) {
    await run('alice account request', commands.openAccount(alice))
    await waitFor('alice account', () => reader.account(alice), 120_000)
  }
  await run(`alice supplies ${supply} USDCx`, commands.supply(alice, supply.toFixed()))
}

// 2. Collateral and loan
if (deposit.gt(0))
  await run(`deposit ${deposit} CC`, commands.depositCollateral(user, ccId, deposit.toFixed()))
if (loan.gte(1)) await run(`borrow ${loan} USDCx`, commands.borrow(user, loan.toFixed()))

// 3. The price drops until the liquidation point is 80% of the debt
const debt = target
const low = debt
  .mul(0.8)
  .div(collateral.mul(cc.liquidateCollateralFactor))
  .toDecimalPlaces(6, 1)
  .toFixed()
const { feed } = await ccMid()
const now = new Date().toISOString()
await ledger.submit(
  [feed.payload.oracle],
  [
    {
      ExerciseCommand: {
        templateId: TEMPLATES.priceFeed,
        contractId: feed.contractId,
        choice: 'PriceFeed_Update',
        choiceArgument: {
          newQuotes: [
            { source: 'scenario-a', price: low, observedAt: now },
            { source: 'scenario-b', price: low, observedAt: now },
          ],
        },
      },
    },
  ],
)
console.log(`CC price published at ${low}`)

// 4. The absorber takes the account: the debt is gone, a deposit remains
const absorbed = await waitFor(
  'absorb by the absorber bot',
  async () => {
    const a = await reader.account(user)
    const s = await reader.snapshot()
    if (!a || a.payload.collateral.some(([m]) => m === ccId)) return null
    return presentValue(dec(a.payload.principal), {
      supplyIndex: dec(s.pool.payload.state.supplyIndex),
      borrowIndex: dec(s.pool.payload.state.borrowIndex),
    })
  },
  120_000,
)
console.log(`absorbed: Bob's balance is now ${absorbed.toFixed(4)} USDCx`)
if (absorbed.lt(0)) throw new Error('absorbed account still has a debt')

// 5. The buyers take the stock
await waitFor(
  'collateral bought by the buyer bots',
  async () => {
    const s = await reader.snapshot()
    const m = s.markets.get(ccId)
    return m && dec(m.protocolCollateral).isZero() ? m : null
  },
  600_000,
)
const s1 = await reader.snapshot()
console.log(`stock sold; pool cash ${s1.pool.payload.state.cash}`)
console.log('scenario passed')
