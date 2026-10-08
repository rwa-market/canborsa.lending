import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Test POST headers in a cookie-session context (F-15): without X-Lending-Client and Origin
 * the backend rejects cookie non-GET requests as CSRF. Origin is the same as the app's.
 */
export const WEB_HEADERS = {
  'x-lending-client': 'web',
  origin: new URL(process.env.E2E_BASE_URL ?? 'http://localhost:5173').origin,
}

type Market = 'CBTC' | 'CC'

/**
 * Action → button on the Compound-style dashboard: Supply/Repay and Withdraw/Borrow under the
 * USDCx balance; Deposit/"Unlock collateral" are the + and − of a collateral row.
 */
function rowButton(label: string, market?: Market): string {
  switch (label) {
    case 'Supply':
      return 'Supply USDCx'
    case 'Withdraw':
      return 'Withdraw USDCx'
    case 'Deposit':
      return `Supply ${market}`
    case 'Borrow':
      return 'Borrow USDCx'
    case 'Repay':
      return 'Repay USDCx'
    case 'Unlock collateral':
      return `Withdraw ${market}`
    default:
      throw new Error(`unknown action ${label}`)
  }
}

/** Sign button in the operation dialog: "Supply USDCx", "Borrow USDCx", "Withdraw CBTC". */
export function submitName(label: string, market?: Market): string {
  switch (label) {
    case 'Supply':
      return 'Supply USDCx'
    case 'Withdraw':
      return 'Withdraw USDCx'
    case 'Deposit':
      return `Supply ${market}`
    case 'Borrow':
      return 'Borrow USDCx'
    case 'Repay':
      return 'Repay USDCx'
    case 'Unlock collateral':
      return `Withdraw ${market}`
    default:
      throw new Error(`unknown action ${label}`)
  }
}

export const submitButton = (page: Page, label: string, market?: Market): Locator =>
  page
    .locator('#action-panel')
    .getByRole('button', { name: submitName(label, market), exact: true })

/** Go to an app page: the session in the context's httpOnly cookie survives navigation (F-15). */
export async function openPage(page: Page, path: string) {
  if (new URL(page.url()).pathname === path) return
  await closeDialog(page)
  // Via a menu link, without reload: the node wallet keeps the token in memory, and a reload
  // restarts the silent OIDC sign-in
  const link = page.locator(`header a[href="${path}"]`).first()
  if (await link.isVisible().catch(() => false)) {
    await link.click()
    await page.waitForURL((u) => u.pathname === path)
  } else await page.goto(path)
}

/** Close the operation dialog if it is open (including the "All done!" screen). */
export async function closeDialog(page: Page) {
  const dialog = page.locator('#action-panel')
  if (await dialog.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
}

/** The dashboard offers this action: e.g. there is debt and it can be repaid. */
export async function hasAction(page: Page, label: string, market?: Market) {
  await openPage(page, '/')
  await closeDialog(page)
  const button = page.getByRole('button', { name: rowButton(label, market), exact: true })
  return (await button.isVisible()) && (await button.isEnabled())
}

/**
 * Withdraw all market collateral, if any. Runs on the shared DevNet must not accumulate collateral:
 * the supply cap is shared by everyone, and collateral from past runs blocks new deposits.
 */
export async function withdrawAllCollateral(page: Page, market: Market) {
  if (!(await hasAction(page, 'Unlock collateral', market))) return false
  await chooseAction(page, 'Unlock collateral', market)
  await page.getByRole('button', { name: /^Max/ }).first().click()
  const submit = submitButton(page, 'Unlock collateral', market)
  await expect(submit, `${submitName('Unlock collateral', market)} stays disabled`).toBeEnabled({
    timeout: 90_000,
  })
  await submit.click()
  await expect(toast(page, 'Collateral withdrawn')).toBeVisible({ timeout: 180_000 })
  await closeDialog(page)
  return true
}

/** Open the operation dialog with a dashboard button. */
export async function chooseAction(page: Page, label: string, market?: Market) {
  await openPage(page, '/')
  await closeDialog(page)
  await page.getByRole('button', { name: rowButton(label, market), exact: true }).click()
  await expect(page.locator('#action-panel')).toBeVisible()
}

export async function submitAmount(page: Page, amount: string, label: string, market?: Market) {
  const input = page.getByLabel(/^Amount/)
  await expect(async () => {
    await input.fill(amount)
    await page.waitForTimeout(300)
    await expect(input).toHaveValue(amount, { timeout: 500 })
  }).toPass({ timeout: 20_000 })
  const submit = submitButton(page, label, market)
  await expect(submit).toBeEnabled()
  await submit.click()
}

/** Sonner toast with this text: not to be confused with the "Supplied" history row. */
export const toast = (page: Page, text: string | RegExp) =>
  page
    .locator('[data-sonner-toast]')
    .filter({ hasText: typeof text === 'string' ? new RegExp(`^\\s*${text}\\s*$`) : text })
    .last()

/**
 * POST to the backend dev API as a demo party: the session is the tab's httpOnly cookie (F-15),
 * the browser sends it itself; the X-Lending-Client header and page Origin pass the CSRF check.
 * The Demo page is gone; tests can reach the faucet and oracle price only this way.
 */
async function devPost<T>(page: Page, path: string, body: unknown): Promise<T> {
  const r = await page.evaluate(
    async ([path, body]) => {
      const res = await fetch(`/api${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-lending-client': 'web' },
        body: JSON.stringify(body),
      })
      return { status: res.status, text: await res.text() }
    },
    [path, body] as const,
  )
  if (r.status >= 300) throw new Error(`POST ${path}: ${r.status} ${r.text}`)
  return JSON.parse(r.text) as T
}

/** Publish a demo oracle price and reload the page with fresh data. */
export async function publishPrice(page: Page, symbol: 'CC' | 'CBTC', price: string) {
  await devPost(page, '/dev/prices', { [symbol]: price })
  await page.reload()
}

/** Test token faucet: a fixed portion to the demo party's wallet. */
export async function faucet(page: Page, symbol: 'USDCx' | 'CC' | 'CBTC') {
  const r = await devPost<{ symbol: string; amount: string }>(page, '/dev/faucet', { symbol })
  expect(r.symbol).toBe(symbol)
  await page.reload()
}

/** Market position from scratch: repay all debt and return all collateral (repeated runs). */
export async function resetPosition(page: Page, market: Market) {
  const panel = page.locator('#action-panel')
  if (await hasAction(page, 'Repay', market)) {
    await chooseAction(page, 'Repay', market)
    await panel.getByRole('button', { name: /^Repay all:/ }).click()
    await submitButton(page, 'Repay', market).click()
    await expect(toast(page, 'Repaid')).toBeVisible({ timeout: 60_000 })
  }
  if (await hasAction(page, 'Unlock collateral', market)) {
    await chooseAction(page, 'Unlock collateral', market)
    const max = panel.getByRole('button', { name: /^Max:/ })
    if (await max.isVisible()) {
      await max.click()
      await submitButton(page, 'Unlock collateral', market).click()
      await expect(toast(page, 'Collateral withdrawn')).toBeVisible({ timeout: 60_000 })
    }
  }
  await closeDialog(page)
}
