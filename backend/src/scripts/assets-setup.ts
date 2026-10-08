/**
 * Custodian setup for real assets, idempotent (seam 2):
 *
 *   pnpm --filter @lending/backend assets:setup-cc        TransferPreapproval CC
 *   pnpm --filter @lending/backend assets:setup-xreserve  onboarding to the xReserve bridge
 *   pnpm --filter @lending/backend assets:setup-registry  DepositRegistry only
 *
 * cc and xreserve also create the DepositRegistry: without it the deposits bot and xReserve claim
 * wait.
 *
 * ASSET_PROFILE=real only (REAL_ASSETS=true, testnet|mainnet). Commands come from the custodian:
 * the LEDGER_CUSTODY_* credential is required. The DepositRegistry is signed by operator and
 * custodian together: for it, the default credential (LEDGER_TOKEN or LEDGER_CLIENT_ID…) with
 * CanActAs for both parties, as for deployProd. A repeated run prints the state and creates
 * nothing.
 */
import {
  setupCcPreapproval,
  setupDepositRegistry,
  setupXreserveOnboarding,
} from '../assets/setup.ts'
import { assertDeploymentMatchesProfile } from '../assets/profiles.ts'
import { loadConfig } from '../config.ts'
import { loadDeployment } from '../deployment.ts'
import { createLedgerClient } from '../ledger/client.ts'
import { createRoleLedgers, tokenSource } from '../ledger/credentials.ts'

const [what] = process.argv.slice(2).filter((a) => a !== '--')
const config = loadConfig()
const profile = config.realProfile
if (!profile)
  throw new Error('assets:setup-* needs ASSET_PROFILE=real, REAL_ASSETS=true and testnet|mainnet')
const d = loadDeployment(config.DEPLOYMENT_PATH)
assertDeploymentMatchesProfile(d, profile)
const custody = d.evm!.custody
const { ledger } = await createRoleLedgers(
  {
    LEDGER_API_URL: config.LEDGER_API_URL,
    LEDGER_PAGE_SIZE: config.LEDGER_PAGE_SIZE,
    LEDGER_MAX_PAGES: config.LEDGER_MAX_PAGES,
    credentials: config.credentials,
    publicNetwork: true,
  },
  d,
)

/** DepositRegistry of operator and custodian: a shared step for cc, xreserve and registry. */
async function registryStep() {
  const joint = config.credentials.default
  if (!joint) {
    console.log(
      'DepositRegistry: set LEDGER_TOKEN (CanActAs operator and custody) to create it; skipped',
    )
    return
  }
  const both = createLedgerClient(
    { LEDGER_API_URL: config.LEDGER_API_URL, LEDGER_USER_ID: joint.userId },
    await tokenSource(joint),
  )
  const reg = await setupDepositRegistry(both, d.operator, custody)
  console.log(`DepositRegistry for ${custody}: ${reg.state} ${reg.contractId ?? ''}`)
}

if (what === 'registry') {
  await registryStep()
} else if (what === 'cc') {
  const r = await setupCcPreapproval(ledger, profile, custody, config.CC_PREAPPROVAL_PROVIDER)
  console.log(`TransferPreapproval for ${custody}: ${r.state} ${r.contractId ?? ''}`)
  if (r.state !== 'exists')
    console.log(
      'the provider accepts the proposal (validator wallet automation); run again to check',
    )
  console.log(
    'with a preapproval CC transfers are direct: the deposits bot credits them by memo via EvmWallet_CreditDeposit',
  )
  await registryStep()
} else if (what === 'xreserve') {
  const r = await setupXreserveOnboarding(ledger, profile, custody)
  console.log(`BridgeUserAgreement for ${custody}: ${r.state} ${r.contractId ?? ''}`)
  if (r.state !== 'exists')
    console.log('waiting for the bridge operator to accept the request; run again to check')
  await registryStep()
} else {
  console.error('usage: assets-setup cc | xreserve | registry')
  process.exit(2)
}
