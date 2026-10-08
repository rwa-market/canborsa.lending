import { expect, test } from '@playwright/test'

test('fits a phone screen without horizontal scroll', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'USDCx balance' })).toBeVisible({
    timeout: 120_000,
  })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  // navigation moves into the menu; sign-in is the same Connect wallet (Loop) button
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(
    page.locator('#mobile-nav').getByRole('link', { name: 'Markets', exact: true }),
  ).toBeVisible()
})
