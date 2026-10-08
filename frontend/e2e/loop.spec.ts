import { loopLoginMessage, type LoopMessageFields, loopMessage } from '@lending/shared'
import { expect, type Page, type Route, test } from '@playwright/test'

/**
 * Loop wallet without network (lending-core-v2, Compound V3 screen): @fivenorth/loop-sdk is replaced by a module
 * from the test, /api by test responses. It checks the frontend path: "Connect wallet" right away
 * opens Loop (no picker dialog) → SDK QR → sign-in text with key, nonce → signMessage → /auth/loop/login;
 * supply: /loop/prepare → exact text in "You are signing" → signMessage → /loop/submit.
 *
 * Needs the Vite dev server: the SDK module is replaced at the dependency pre-bundling path
 * (/node_modules/.vite/deps/@fivenorth_loop-sdk.js). A prod build (E2E_BASE_URL) does not work.
 *   pnpm --filter @lending/frontend exec playwright test e2e/loop.spec.ts --project=desktop
 */

const PARTY = `alice-loop::1220${'a'.repeat(64)}`
const SUBJECT = `loop:${PARTY}`
const KEY = 'ab'.repeat(32)
const OPERATOR = `operator::1220${'c'.repeat(64)}`
const CUSTODY = `custody::1220${'d'.repeat(64)}`
const NETWORK = 'canton:devnet'
const SIG = Uint8Array.from({ length: 64 }, (_, i) => i)
const SIG_HEX = Buffer.from(SIG).toString('hex')
const NONCE = 'f'.repeat(60)
const inst = (id: string) => ({ admin: `registry::1220${'e'.repeat(64)}`, id })

/**
 * Browser SDK module: a QR dialog (`.loop-connect`) with an approve button, a provider with
 * party_id and public_key; signMessage waits until the test releases the signature (`release`),
 * and returns { signature: base64 }; the frontend must convert it to hex.
 */
const FAKE_SDK = `
const S = (window.__loopTest ??= { signed: [], connects: 0 })
export class PopupClosedError extends Error {}
export class RejectRequestError extends Error {}
export class RequestTimeoutError extends Error {}
export class UnauthorizedError extends Error {}
export class PaymentRequiredError extends Error {}
let opts = null
let session = false
const provider = {
  party_id: ${JSON.stringify(PARTY)},
  public_key: ${JSON.stringify(KEY)},
  signMessage(message) {
    S.signed.push(message)
    return new Promise((resolve, reject) => {
      S.release = () => resolve({ signature: ${JSON.stringify(Buffer.from(SIG).toString('base64'))} })
      S.reject = () => reject(new RejectRequestError('rejected'))
    })
  },
}
export const loop = {
  init(o) { opts = o; S.init = { appName: o.appName, network: o.network, walletUrl: o.walletUrl, secondaryWalletUrl: o.secondaryWalletUrl } },
  async autoConnect() { if (session) opts.onAccept(provider) },
  async connect() {
    S.connects++
    if (session) return opts.onAccept(provider)
    const overlay = document.createElement('div')
    overlay.className = 'loop-connect'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6)'
    const approve = document.createElement('button')
    approve.textContent = 'Approve in Loop'
    approve.style.cssText = 'position:absolute;top:40%;left:40%'
    approve.onclick = () => { session = true; opts.onAccept(provider); overlay.remove() }
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
    const old = document.createElement('button')
    old.className = 'switch-link'
    old.textContent = 'Using the old wallet?'
    overlay.appendChild(approve)
    overlay.appendChild(old)
    document.body.appendChild(overlay)
  },
  logout() { session = false; S.loggedOut = true },
}
`

interface Mock {
  calls: { path: string; body: unknown }[]
  supplied: string
}

const pool = {
  debtInstrument: inst('USDCx'),
  totalSupplied: '1000',
  totalBorrowed: '0',
  cash: '1000',
  reserves: '0',
  netReserves: '0',
  targetReserves: '50000',
  collateralForSale: false,
  utilization: '0',
  totalCollateralUsd: '14000',
  availableLiquidity: '800',
  collateralization: null,
  borrowApr: '0.02',
  supplyApr: '0.01',
  limits: {
    totalBorrowCap: '50000',
    maxDebtPerUser: '5000',
    minLoan: '250',
    maxUtilization: '0.8',
    liquidationRiskWarning: '0.71',
  },
  rateModel: {
    baseRate: '0',
    slope1: '0.04',
    slope2: '0.75',
    optimalUtilization: '0.8',
    maxUtilization: '0.8',
    reserveFactor: '0.1',
  },
  storeFrontPriceFactor: '0.6',
  governed: false,
  councilSize: 0,
  featuredApp: false,
  pauses: {
    borrowPaused: false,
    collateralWithdrawPaused: false,
    supplyWithdrawPaused: false,
    absorbPaused: false,
    buyPaused: false,
  },
  markets: [
    {
      marketId: 'CC',
      instrument: inst('Amulet'),
      borrowCollateralFactor: '0.25',
      liquidateCollateralFactor: '0.35',
      liquidationFactor: '0.93',
      liquidationPenalty: '0.07',
      supplyCap: '5000000',
      minCollateralAmount: '10',
      totalCollateral: '20000',
      totalCollateralUsd: '4000',
      protocolCollateral: '0',
      protocolCollateralBasis: '0',
      purchaseDiscount: '0.042',
      price: '0.2',
      requiresReserveAttestation: false,
      reserveCoverage: null,
    },
    {
      marketId: 'CBTC',
      instrument: inst('CBTC'),
      borrowCollateralFactor: '0.7',
      liquidateCollateralFactor: '0.8',
      liquidationFactor: '0.95',
      liquidationPenalty: '0.05',
      supplyCap: '10',
      minCollateralAmount: '0.0001',
      totalCollateral: '0.1',
      totalCollateralUsd: '10000',
      protocolCollateral: '0',
      protocolCollateralBasis: '0',
      purchaseDiscount: '0.03',
      price: '100000',
      requiresReserveAttestation: true,
      reserveCoverage: '1.02',
    },
  ],
  prices: {},
}

/** A borrower (control example 1): 20 000 CC and 0.1 CBTC, debt 1 000 USDCx. */
const BORROWER = {
  collateral: [
    { marketId: 'CC', amount: '20000', valueUsd: '4000', priceValid: true },
    { marketId: 'CBTC', amount: '0.1', valueUsd: '10000', priceValid: true },
  ],
  summary: {
    balance: '-1000',
    supplied: '0',
    borrowed: '1000',
    collateralValueUsd: '14000',
    borrowCapacityUsd: '6200',
    availableToBorrow: '4000',
    maxBorrow: '4000',
    liquidationPointUsd: '8300',
    liquidationRisk: '0.1204819277',
    status: 'healthy',
    netApr: '-0.02',
    absorbPenaltyUsd: '700',
  },
}

const positionOf = (s: {
  balance: string
  availableToBorrow: string
  liquidationRisk: string | null
}) => ({
  balance: s.balance,
  borrowCapacityUsd: '6200',
  availableToBorrow: s.availableToBorrow,
  liquidationPointUsd: '8300',
  liquidationRisk: s.liquidationRisk,
})

/** EvmAction for /loop/prepare (K2): the same kinds the contract signs. */
function actionOf(body: Record<string, unknown>) {
  const amount = body.amount as string
  switch (body.op) {
    case 'supply':
      return { kind: 'supply' as const, amount, full: !!body.full }
    case 'withdraw':
      return { kind: 'withdraw' as const, amount, full: !!body.full }
    case 'borrow':
      return { kind: 'borrow' as const, amount }
    default:
      throw new Error(`not mocked: op ${String(body.op)}`)
  }
}
const TAG = { supply: 'EvmSupply', withdraw: 'EvmWithdraw', borrow: 'EvmBorrow' } as const

async function mockApi(
  page: Page,
  opts: { borrower?: boolean; decman?: boolean } = {},
): Promise<Mock> {
  const m: Mock = { calls: [], supplied: '0' }
  let session = false
  let loopFields: LoopMessageFields | null = null
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    const body = route.request().postDataJSON() as Record<string, unknown> | null
    m.calls.push({ path, body })
    const account = opts.borrower
      ? { accountCid: 'acc-1', owner: CUSTODY, ...BORROWER }
      : {
          accountCid: 'acc-1',
          owner: CUSTODY,
          collateral: [],
          summary: {
            balance: m.supplied,
            supplied: m.supplied,
            borrowed: '0',
            collateralValueUsd: '0',
            borrowCapacityUsd: '0',
            availableToBorrow: '0',
            maxBorrow: m.supplied,
            liquidationPointUsd: '0',
            liquidationRisk: null,
            status: 'no-debt',
            netApr: m.supplied === '0' ? null : '0.01',
            absorbPenaltyUsd: null,
          },
        }
    switch (true) {
      case path === '/config':
        return json(route, {
          instruments: { usdcx: inst('USDCx'), cc: inst('Amulet'), cbtc: inst('CBTC') },
          markets: ['CC', 'CBTC'],
          roles: {
            operator: OPERATOR,
            guardian: OPERATOR,
            treasury: OPERATOR,
            liquidator: OPERATOR,
            backstop: OPERATOR,
          },
          testFaucet: true,
          networkId: NETWORK,
          network: { name: 'devnet', networkId: NETWORK, synchronizerId: null },
          loop: { enabled: true, network: 'devnet', appName: 'Canton Lending', custody: CUSTODY },
        })
      case path.startsWith('/health'):
        return json(route, { status: 'ok', version: 'test', ledger: 'connected' })
      case path === '/pool':
        return json(route, pool)
      case path === '/auth/session':
        return session
          ? json(route, {
              party: SUBJECT,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            })
          : json(route, { error: 'no session' }, 401)
      case path === '/auth/logout':
        session = false
        return json(route, { revoked: true })
      case path === '/auth/loop/challenge':
        return json(route, {
          nonce: NONCE,
          publicKey: KEY,
          message: loopLoginMessage({
            host: url.host,
            party: PARTY,
            publicKey: KEY,
            network: NETWORK,
            nonce: NONCE,
            issuedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
        })
      case path === '/auth/loop/login':
        session = true
        return json(route, { party: SUBJECT })
      case path.startsWith('/accounts/'):
        return json(route, { account })
      case path.startsWith('/wallet/'):
        return json(route, {
          USDCx: m.supplied === '0' ? '1000' : '900',
          CC: '0',
          CBTC: '0',
        })
      case path.startsWith('/history/'):
        return json(route, { operations: [] })
      case path === '/preview': {
        const before = positionOf(
          opts.borrower
            ? BORROWER.summary
            : { balance: m.supplied, availableToBorrow: '0', liquidationRisk: null },
        )
        // borrow 300 against example 1: debt 1 300, risk 15.66 %
        const after =
          opts.borrower && body?.op === 'borrow'
            ? {
                ...before,
                balance: '-1300',
                availableToBorrow: '3700',
                liquidationRisk: '0.1566265060',
              }
            : before
        return json(route, {
          before,
          after,
          blockers: [],
          warnings: [],
          amount: (body?.amount as string) ?? null,
          all: !!body?.all,
          maxTransfer: null,
          repaysDebt: null,
        })
      }
      case path === '/loop/prepare': {
        const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 600_000).toISOString()
        const action = actionOf(body!)
        loopFields = {
          network: NETWORK,
          operator: OPERATOR,
          party: PARTY,
          action,
          debt: 'USDCx',
          nonce: 0,
          expiresAt,
        }
        const { kind, ...value } = action
        return json(route, {
          actAs: [CUSTODY],
          commands: [
            {
              ExerciseCommand: {
                templateId: '#lending-core-v2:Lending.Pool:Pool',
                contractId: 'pool-1',
                choice: 'Pool_LoopWalletExecute',
                choiceArgument: {
                  custody: CUSTODY,
                  walletCid: 'wallet-1',
                  action: { tag: TAG[kind], value },
                  signedMessage: loopMessage(loopFields),
                  signature: '',
                  nonce: '0',
                  expiresAt,
                },
              },
            },
          ],
          disclosedContracts: [],
          loop: loopFields,
          seal: 'seal-1',
          message: loopMessage(loopFields),
        })
      }
      case path === '/loop/submit':
        if (!opts.borrower) m.supplied = '100'
        return json(route, { updateId: 'update-1' })
      case path === '/governance':
        return json(
          route,
          opts.decman
            ? DECMAN_GOVERNANCE
            : { council: null, roles: {}, proposals: [], rotations: [], income: [] },
        )
      default:
        return json(route, { error: `not mocked: ${path}` }, 404)
    }
  })
  await page.route('**/node_modules/.vite/deps/@fivenorth_loop-sdk.js*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_SDK }),
  )
  return m
}

// Review item 25: the council seat is a BitSafe Decentralized Party; its members vote in DecMan
// on their nodes (the member's own view is covered in council/model.test.ts)
const COUNCIL_DP = `lending-council::1220${'b'.repeat(64)}`
const other = (n: string) => `${n}::1220${'9'.repeat(64)}`
const DECMAN_GOVERNANCE = {
  council: { contractId: 'council-1', members: [COUNCIL_DP], threshold: 1 },
  decman: {
    governanceParty: COUNCIL_DP,
    members: [other('bitsafe-node1'), other('bitsafe-node2'), other('bitsafe-node3')],
    threshold: 2,
    actions: [
      {
        contractId: 'act-1',
        label: 'LendingParams',
        description: 'Lending params-7 (operator op): CBTC borrowCollateralFactor 0.5 -> 0.45',
        proposer: other('bitsafe-node2'),
        confirmations: [other('bitsafe-node2')],
      },
    ],
  },
  roles: {
    operator: OPERATOR,
    oracle: other('oracle'),
    guardian: other('guardian'),
    treasury: other('treasury'),
    backstop: other('backstop'),
    liquidators: [other('liquidator')],
  },
  proposals: [],
  rotations: [],
  income: [],
}

type LoopTest = { signed: string[]; release?: () => void; init?: unknown; connects: number }
const loopState = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __loopTest: LoopTest }).__loopTest
    return { signed: s.signed, init: s.init, connects: s.connects }
  })
const release = (page: Page) =>
  page.evaluate(() => (window as unknown as { __loopTest: LoopTest }).__loopTest.release!())

async function signIn(page: Page) {
  // "Connect wallet" opens Loop right away: there is no wallet picker
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click()
  await expect(page.getByRole('dialog', { name: 'Connect a wallet' })).toHaveCount(0)
  // the SDK's "Using the old wallet?" switch leads to looptech.io, where Google sign-in fails
  await expect(page.locator('.loop-connect .switch-link')).toBeHidden()
  await page.getByRole('button', { name: 'Approve in Loop' }).click()
  // the "You are signing" dialog shows the sign-in text as is until Loop has signed
  const text = page.getByLabel('Text to sign')
  await expect(text).toContainText('wants you to sign in to Canton Lending with your Loop wallet')
  await expect(text).toContainText(`Public Key: ${KEY}`)
  await release(page)
}

test.describe('Loop wallet (mocked SDK and API)', () => {
  test('signs in with Connect wallet and supplies with the exact text shown', async ({ page }) => {
    const m = await mockApi(page)
    await page.goto('/')
    await signIn(page)

    const banner = page.getByRole('banner')
    await expect(banner.getByRole('button', { name: /^Loop account / })).toBeVisible()
    const s = await loopState(page)
    // DevNet: the Loop window is on devnet.cantonloop.com only, the fallback included; on
    // wallet.devnet.looptech.io Google responds with origin_mismatch
    expect(s.init).toEqual({
      appName: 'Canton Lending',
      network: 'devnet',
      walletUrl: 'https://devnet.cantonloop.com',
      secondaryWalletUrl: 'https://devnet.cantonloop.com',
    })
    expect(s.signed[0]).toContain(`Nonce: ${NONCE}`)
    expect(m.calls.find((c) => c.path === '/auth/loop/challenge')!.body).toEqual({
      party: PARTY,
      publicKey: KEY,
    })
    const login = m.calls.find((c) => c.path === '/auth/loop/login')!.body
    // the signature from { signature: base64 } reached the backend as hex
    expect(login).toEqual({
      party: PARTY,
      publicKey: KEY,
      nonce: NONCE,
      message: s.signed[0],
      signature: SIG_HEX,
    })

    // Compound's layout: no separate wallet block; USDCx in the wallet sits with the rates, a
    // collateral asset shows its wallet balance (and the DevNet faucet) under its name
    const walletCard = page.getByRole('region', { name: 'USDCx wallet balance and rates' })
    await expect(walletCard).toContainText('1,000.00')
    await expect(walletCard).toContainText('Net Supply APR')
    await expect(walletCard.getByRole('button', { name: 'Get test USDCx' })).toBeVisible()
    const ccRow = page.getByRole('listitem', { name: 'CC collateral' })
    await expect(ccRow).toContainText('0.00 in wallet')
    await expect(ccRow.getByRole('button', { name: 'Get test CC' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Wallet balance', exact: true })).toHaveCount(0)

    // supply: the operation text was built by the frontend and matched the backend text
    await page.getByRole('button', { name: 'Supply USDCx', exact: true }).click()
    const panel = page.locator('#action-panel')
    await expect(panel).toBeVisible()
    await panel.getByLabel(/^Amount/).fill('100')
    const submit = panel.getByRole('button', { name: 'Supply USDCx', exact: true })
    await expect(submit).toBeEnabled()
    await submit.click()
    const text = page.getByLabel('Text to sign')
    await expect(text).toContainText('Supply 100.0 USDCx')
    await expect(text).toContainText(`Account: ${PARTY}`)
    await release(page)
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Supplied' })).toBeVisible()

    const signed = (await loopState(page)).signed
    expect(signed.at(-1)).toMatch(/^Canton Lending\nSupply 100\.0 USDCx\nAccount: alice-loop::/)
    const prepare = m.calls.find((c) => c.path === '/loop/prepare')!.body
    // K2: the operation by EvmAction kind, a typed amount is not "all"
    expect(prepare).toEqual({ party: PARTY, op: 'supply', amount: '100', full: false })
    const submitted = m.calls.find((c) => c.path === '/loop/submit')!.body as Record<
      string,
      unknown
    >
    expect(submitted.signature).toBe(SIG_HEX)
    expect(submitted.seal).toBe('seal-1')
    expect(submitted.message).toBe(signed.at(-1))
  })

  test('MAX writes the exact balance into the field and still sends "all"', async ({ page }) => {
    const m = await mockApi(page)
    await page.goto('/')
    await signIn(page)
    await page.getByRole('button', { name: 'Supply USDCx', exact: true }).click()
    const panel = page.locator('#action-panel')
    await panel.getByLabel(/^Amount/).fill('100')
    await panel.getByRole('button', { name: 'Supply USDCx', exact: true }).click()
    await expect(page.getByLabel('Text to sign')).toContainText('Supply 100.0 USDCx')
    await release(page)
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Supplied' })).toBeVisible()
    await page.keyboard.press('Escape')

    // a supplier still has all four actions: Borrow stays next to Repay
    await expect(page.getByRole('button', { name: 'Borrow USDCx', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Withdraw USDCx', exact: true }).click()
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: /^Max:/ }).click()
    // the field holds a number, not the word "max"; "all" goes to the preview and the command
    await expect(panel.getByLabel(/^Amount/)).toHaveValue('100')
    await expect
      .poll(() => m.calls.filter((c) => c.path === '/preview').at(-1)?.body)
      .toMatchObject({ op: 'withdraw', amount: '100', all: true })
    // the withdrawal is signed as "withdraw all", never as a loan
    await panel.getByRole('button', { name: 'Withdraw USDCx', exact: true }).click()
    await expect(page.getByLabel('Text to sign')).toContainText('Withdraw all USDCx')
    expect(m.calls.filter((c) => c.path === '/loop/prepare').at(-1)?.body).toEqual({
      party: PARTY,
      op: 'withdraw',
      amount: '100',
      full: true,
    })
    await page.evaluate(() =>
      (window as unknown as { __loopTest: { reject: () => void } }).__loopTest.reject(),
    )
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Signature cancelled' }),
    ).toBeVisible()
    // manual edit: a regular amount
    await panel.getByLabel(/^Amount/).fill('40')
    await expect(panel.getByText(/^Withdraw all:/)).toHaveCount(0)
    await expect
      .poll(() => m.calls.filter((c) => c.path === '/preview').at(-1)?.body)
      .toEqual({ op: 'withdraw', party: SUBJECT, amount: '40' })
  })

  test('a borrower sees Repay, the Position Summary and borrows with before → after', async ({
    page,
  }) => {
    const m = await mockApi(page, { borrower: true })
    await page.goto('/')
    await signIn(page)

    // the four USDCx actions are always there, in two groups: Earn and Borrow
    const balance = page.getByRole('region', { name: 'USDCx balance' })
    await expect(balance).toContainText('USDCx borrowed')
    await expect(balance).toContainText('1,000.00')
    const earn = balance.getByRole('group', { name: 'Earn' })
    await expect(earn.getByRole('button', { name: 'Supply USDCx', exact: true })).toBeVisible()
    await expect(earn.getByRole('button', { name: 'Withdraw USDCx', exact: true })).toBeVisible()
    const borrow = balance.getByRole('group', { name: 'Borrow' })
    await expect(borrow.getByRole('button', { name: 'Borrow USDCx', exact: true })).toBeVisible()
    await expect(borrow.getByRole('button', { name: 'Repay USDCx', exact: true })).toBeVisible()

    // Collateral Asset / Protocol Balance with + and −
    const cc = page.getByRole('listitem', { name: 'CC collateral' })
    await expect(cc).toContainText('20,000.00')
    await expect(cc.getByRole('button', { name: 'Supply CC' })).toBeVisible()
    await expect(cc.getByRole('button', { name: 'Withdraw CC' })).toBeVisible()

    // Position Summary straight from AccountSummary (control example 1)
    const summary = page.getByRole('region', { name: 'Position Summary' })
    await expect(summary).toContainText('$14,000.00')
    await expect(summary).toContainText('$6,200.00')
    await expect(summary).toContainText('4,000.00 USDCx')
    await expect(summary).toContainText('$8,300.00')
    await expect(summary).toContainText('12.0%')
    await expect(summary.getByRole('img', { name: /^Liquidation risk 12.0%, safe/ })).toBeVisible()
    await expect(summary).toContainText('you lose about $700.00')
    // Ф3: no collateral switch, no per-market health factor
    await expect(page.getByRole('switch')).toHaveCount(0)
    await expect(page.getByText(/health factor/i)).toHaveCount(0)

    // Ф6: Borrow is explicit, before → after comes from the preview
    await page.getByRole('button', { name: 'Borrow USDCx', exact: true }).click()
    const panel = page.locator('#action-panel')
    await panel.getByLabel(/^Amount/).fill('300')
    await expect(panel).toContainText('−1,300.00 USDCx')
    await expect(panel).toContainText('15.6%')
    await expect(panel.getByText('Net Borrow APR', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Borrow USDCx', exact: true }).click()
    await expect(page.getByLabel('Text to sign')).toContainText('Borrow 300.0 USDCx')
    await release(page)
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Borrowed' })).toBeVisible()
    expect(m.calls.filter((c) => c.path === '/loop/prepare').at(-1)?.body).toEqual({
      party: PARTY,
      op: 'borrow',
      amount: '300',
    })
    expect(m.calls.filter((c) => c.path === '/preview').at(-1)?.body).toEqual({
      op: 'borrow',
      party: SUBJECT,
      amount: '300',
    })
  })

  test('markets list opens the USDCx market, where its actions are', async ({ page }) => {
    await mockApi(page)
    await page.goto('/markets')
    await expect(page.getByRole('heading', { name: 'Markets', exact: true })).toBeVisible()
    // the header's market selector, as on Compound: networks on the left, their markets on the right
    await page
      .getByRole('banner')
      .getByRole('button', { name: /USDCx\s*Canton DevNet/ })
      .click()
    const selector = page.getByRole('dialog', { name: 'Select a market' })
    await expect(selector.getByRole('button', { name: /Canton DevNet/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(selector.getByRole('button', { name: 'USDCx', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await selector.getByRole('button', { name: 'USDCx', exact: true }).click()
    await expect(selector).toHaveCount(0)
    const row = page.getByRole('listitem', { name: 'USDCx market on DevNet' })
    await expect(row).toContainText('Net Earn APR')
    await expect(row).toContainText('$14,000.00')
    await row.click()
    await expect(page).toHaveURL(/\/markets\/usdcx-canton$/)
    await expect(page.getByRole('heading', { name: /^USDCx/ })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Market stats' })).toContainText('800')
    await expect(page.getByRole('img', { name: /^Borrow APR 0% at 0% utilization/ })).toBeVisible()
    const cbtc = page.getByRole('listitem', { name: 'CBTC collateral asset' })
    await expect(cbtc).toContainText('70%')
    await expect(cbtc).toContainText('80%')
    await expect(cbtc).toContainText('5%')
    await expect(cbtc).toContainText('$100,000.00')
    // target actions on the market page: the four USDCx operations and collateral +/−
    const position = page.getByRole('region', { name: 'Your position in this market' })
    for (const name of ['Supply USDCx', 'Borrow USDCx', 'Withdraw USDCx', 'Repay USDCx'])
      await expect(position.getByRole('button', { name, exact: true })).toBeEnabled()
    await expect(cbtc.getByRole('button', { name: 'Supply CBTC' })).toBeEnabled()
    // Aave-era blocks are gone, and so are the per-asset pages
    await expect(page.getByText(/Supply info|Borrow info|Collector info|APY|Max LTV/)).toHaveCount(
      0,
    )
    await page.goto('/markets/usdc-mainnet')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    await page.goto('/reserve/CC')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  })

  test('no silent blocks: a missing balance or position is explained with the next step', async ({
    page,
  }) => {
    await mockApi(page)
    await page.goto('/markets/usdcx-canton')
    await signIn(page)
    const position = page.getByRole('region', { name: 'Your position in this market' })
    const panel = page.locator('#action-panel')
    // nothing supplied: Withdraw opens and says so, with Supply and Borrow as the way out
    await position.getByRole('button', { name: 'Withdraw USDCx', exact: true }).click()
    await expect(panel).toContainText('You have no USDCx supplied')
    // no debt: Repay explains and switches to Supply in place
    await page.keyboard.press('Escape')
    await position.getByRole('button', { name: 'Repay USDCx', exact: true }).click()
    await expect(panel).toContainText('You have no USDCx debt to repay')
    await panel.getByRole('button', { name: 'Supply USDCx', exact: true }).first().click()
    await expect(panel.getByRole('heading', { name: 'Supply USDCx' })).toBeVisible()
    // more than the wallet holds: said at once, with the amount it holds and the faucet
    await panel.getByLabel(/^Amount/).fill('5000')
    await expect(panel).toContainText('Your wallet holds 1,000.0000 USDCx, less than 5,000.0000')
    await expect(panel.getByRole('button', { name: 'Get test USDCx' })).toBeVisible()
    await panel.getByRole('button', { name: /^Use 1,000/ }).click()
    await expect(panel.getByLabel(/^Amount/)).toHaveValue('1000')
    // borrow without collateral: the collateral deposits are offered
    await page.keyboard.press('Escape')
    await position.getByRole('button', { name: 'Borrow USDCx', exact: true }).click()
    await expect(panel).toContainText('No collateral yet')
    await panel.getByRole('button', { name: 'Supply CC' }).click()
    // CC wallet is empty: the faucet, not a disabled button
    await expect(panel).toContainText('Your wallet holds no CC')
    await expect(panel.getByRole('button', { name: 'Get test CC' })).toBeVisible()
    // collateral − with nothing deposited is clickable and says why
    await page.keyboard.press('Escape')
    const cc = page.getByRole('listitem', { name: 'CC collateral asset' })
    await cc.getByRole('button', { name: 'Withdraw CC' }).click()
    await expect(panel).toContainText('You have no CC collateral to withdraw')
  })

  test('the borrower screen, the dialog and the market page fit 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await mockApi(page, { borrower: true })
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    await page.goto('/')
    await signIn(page)
    await expect(page.getByRole('region', { name: 'Position Summary' })).toContainText('12.0%')
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: 'Borrow USDCx', exact: true }).click()
    const panel = page.locator('#action-panel')
    await panel.getByLabel(/^Amount/).fill('300')
    await expect(panel).toContainText('15.6%')
    const box = await panel.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
    await page.keyboard.press('Escape')
    await page.goto('/markets')
    await expect(page.getByRole('listitem', { name: 'USDCx market on DevNet' })).toBeVisible()
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.goto('/markets/usdcx-canton')
    await expect(page.getByRole('listitem', { name: 'CBTC collateral asset' })).toBeVisible()
    expect(await overflow()).toBeLessThanOrEqual(0)
  })

  test('Connect wallet appears once /config answers again after a backend restart', async ({
    page,
  }) => {
    await mockApi(page)
    // deploy: the backend restarts and the first /config responses are 503
    let failures = 2
    await page.route('**/api/config', (route) =>
      failures-- > 0
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
        : route.fallback(),
    )
    await page.goto('/')
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }),
    ).toBeVisible({ timeout: 20_000 })
  })

  test('closing the Loop window leaves the user signed out without an error', async ({ page }) => {
    const m = await mockApi(page)
    await page.goto('/')
    await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click()
    await page.locator('.loop-connect').click({ position: { x: 5, y: 5 } })
    await expect(page.locator('.loop-connect')).toHaveCount(0)
    const connect = page.getByRole('banner').getByRole('button', { name: 'Connect wallet' })
    await expect(connect).toBeEnabled()
    await expect(page.getByRole('banner').getByRole('alert')).toHaveCount(0)
    expect(m.calls.some((c) => c.path === '/auth/loop/challenge')).toBe(false)
  })

  test('the council page shows the BitSafe party, its threshold and the pending action', async ({
    page,
  }) => {
    await mockApi(page, { decman: true })
    await page.goto('/council')
    await signIn(page)
    const dp = page.getByRole('region', { name: 'BitSafe Decentralized Party' })
    await expect(dp).toContainText('An action executes after 2 of them confirm it in DecMan')
    await expect(dp).toContainText('CBTC borrowCollateralFactor 0.5 -> 0.45')
    await expect(dp).toContainText('1 of 2 confirmations')
    await expect(page.getByText('BitSafe 2 of 3')).toBeVisible()
    await expect(page.getByText('BitSafe party members, 2 of 3')).toBeVisible()
    // only council members propose here; the BitSafe party votes in DecMan
    await expect(page.getByRole('button', { name: 'New proposal' })).toHaveCount(0)
    await page.screenshot({ path: 'test-results/decman-council.png', fullPage: true })
  })
})
