// Upload DARs to the shared DevNet node through its NaaS console: the ledger user of the node
// may not upload packages (JSON API 403, gRPC PERMISSION_DENIED), the console account may.
//
//   node scripts/devnet-upload.mjs daml/lending-core-v2/.daml/dist/lending-core-v2-1.0.3.dar …
//
// Signs in by SSO (Keycloak) with E2E_NODE_USER and E2E_NODE_PASSWORD from .local/devnet/node.env
// (in .gitignore). Upload in dependency order; check with `python3 scripts/devnet.py status`.
/* global process, console, URL, document */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const { chromium } = createRequire(path.join(root, 'frontend/package.json'))('@playwright/test')
const CONSOLE =
  process.env.DEVNET_CONSOLE ??
  'https://console.participant.hackcanton-01.devnet.naas.noders.services'

const envFile = path.join(root, '.local/devnet/node.env')
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const files = process.argv.slice(2)
if (!files.length || !env.E2E_NODE_USER || !env.E2E_NODE_PASSWORD) {
  console.error('usage: node scripts/devnet-upload.mjs <dar>…; E2E_NODE_USER/PASSWORD in', envFile)
  process.exit(2)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(`${CONSOLE}/login`)
  await Promise.all([
    page.waitForURL(/keycloak/),
    page
      .locator('form[action="/login/sso"] [type=submit], form[action="/login/sso"] button')
      .first()
      .click(),
  ])
  await page.fill('#username', env.E2E_NODE_USER)
  await page.fill('#password', env.E2E_NODE_PASSWORD)
  await Promise.all([
    page.waitForURL((u) => u.toString().startsWith(CONSOLE), { timeout: 30_000 }),
    page.click('#kc-login'),
  ])
  await page.goto(`${CONSOLE}/net/collections`)
  for (const file of files) {
    await page.evaluate(() => document.getElementById('dar-upload-modal').showModal())
    await page.selectOption('#participantNodeId', { index: 1 })
    await page.setInputFiles('#darFile', file)
    // The console answers only when the node has the package: a large DAR takes minutes
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/net/collections/upload'), {
        timeout: 600_000,
      }),
      page.click('#dar-upload-modal button[type=submit].cn-button-primary'),
    ])
    const text = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    const ok = res.ok() && /uploaded successfully/.test(text)
    console.log(`${ok ? 'uploaded' : 'FAILED'} ${path.basename(file)} (HTTP ${res.status()})`)
    if (!ok) {
      console.log(text.slice(0, 400))
      process.exitCode = 1
      break
    }
  }
} finally {
  await browser.close()
}
