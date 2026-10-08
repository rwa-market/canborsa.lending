import { type Browser, expect, type Page, test } from '@playwright/test'
import { openPage, toast } from './helpers'

/**
 * Protocol roles on Canton DevNet: sign-in with a node account (OIDC NODERS) on the /operator page,
 * role selection, transactions under the node token. The user is a dashboard guest: the live Loop
 * sign-in scenario cannot pass (it needs a phone with Loop); loop.spec.ts covers it with mocks.
 *
 * Run: E2E_BASE_URL=https://… E2E_NODE_USER=… E2E_NODE_PASSWORD=… \
 *   pnpm --filter @lending/frontend exec playwright test e2e/devnet.spec.ts --project=desktop
 * The node account must act as the lending-Guardian and lending-Treasury parties.
 */
const USER = process.env.E2E_NODE_USER
const PASSWORD = process.env.E2E_NODE_PASSWORD
test.skip(!USER || !PASSWORD, 'set E2E_NODE_USER and E2E_NODE_PASSWORD to run against DevNet')

test.describe.configure({ mode: 'serial' })

/** Sign in with the node account on /operator and pick a role (Guardian, Treasury). */
async function nodeSignIn(page: Page, role: string) {
  await page.goto('/operator')
  await page.getByRole('button', { name: 'Sign in with Canton node' }).click()
  // The node's Keycloak sign-in page or, with a live session, role selection right away
  const user = page.getByRole('textbox', { name: 'Username or email' })
  const choose = page.getByRole('heading', { name: 'Choose a role' })
  await expect(user.or(choose)).toBeVisible({ timeout: 90_000 })
  if (await user.isVisible()) {
    await user.fill(USER!)
    await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD!)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(choose).toBeVisible({ timeout: 90_000 })
  // Only protocol roles: no test or service parties in the list
  await expect(page.getByText(/Tester|Operator|Registry|DemoDSO/)).toHaveCount(0)
  await page.getByRole('button', { name: new RegExp(`^Sign in as .*-${role}$`) }).click()
  await expect(page.getByRole('banner').getByRole('button', { name: /^Node wallet / })).toBeVisible(
    { timeout: 90_000 },
  )
}

/** A node-wallet command waits for an explicit Confirm (review 03.10, item 18). */
async function confirm(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm with your node account' })
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Confirm and sign' }).click()
}

async function asRole(browser: Browser, role: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await nodeSignIn(page, role)
  return page
}

test('guardian pause reaches a user; treasury adds reserves', async ({ browser }) => {
  test.setTimeout(420_000)
  const guardian = await asRole(browser, 'Guardian')
  await openPage(guardian, '/admin')
  const admin = guardian.getByLabel('Risk admin')
  await expect(admin).toBeVisible({ timeout: 60_000 })
  await admin.getByRole('button', { name: 'Pause new loans' }).click()
  await confirm(guardian)
  await expect(admin.getByRole('button', { name: 'Resume new loans' })).toBeVisible({
    timeout: 120_000,
  })
  // user (dashboard guest): the pause is announced on the market screen
  const user = await (await browser.newContext()).newPage()
  await user.goto('/')
  await expect(user.getByText(/Paused by the guardian: new loans/)).toBeVisible({
    timeout: 90_000,
  })
  await admin.getByRole('button', { name: 'Resume new loans' }).click()
  await confirm(guardian)
  await expect(admin.getByRole('button', { name: 'Pause new loans' })).toBeVisible({
    timeout: 120_000,
  })
  await user.context().close()
  await guardian.context().close()

  const treasury = await asRole(browser, 'Treasury')
  await openPage(treasury, '/admin')
  const panel = treasury.getByLabel('Treasury')
  await expect(panel).toBeVisible({ timeout: 60_000 })
  // the faucet for treasury is on the reserves screen: a service role does not see the user dashboard
  await panel.getByRole('button', { name: 'Get test USDCx' }).click()
  await confirm(treasury)
  await expect(toast(treasury, /^Received [0-9,.]+ USDCx$/)).toBeVisible({ timeout: 90_000 })
  await panel.getByLabel(/Add reserves, USDCx/).fill('500')
  await panel.getByRole('button', { name: 'Add reserves' }).click()
  await confirm(treasury)
  await expect(toast(treasury, 'Reserves added')).toBeVisible({ timeout: 120_000 })
  await treasury.context().close()
})

test('the API does not serve party data or dev routes to strangers', async ({ request }) => {
  const config = await (await request.get('/api/config')).json()
  // the demo wallet and demo parties are gone
  expect(config).not.toHaveProperty('devWallet')
  expect(config).not.toHaveProperty('demoParties')
  expect((await request.get(`/api/accounts/${config.roles.operator}`)).status()).toBe(401)
  // The client header passes the CSRF check: the refusal comes from the routes themselves
  const headers = { 'x-lending-client': 'web' }
  expect(
    (await request.post('/api/dev/session', { headers, data: { party: 'x::1220ab' } })).status(),
  ).toBe(404)
  expect((await request.post('/api/faucet', { headers, data: { symbol: 'USDCx' } })).status()).toBe(
    401,
  )
})
