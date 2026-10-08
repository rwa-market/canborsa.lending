/**
 * Setup of the 0.5.0 deployment on DevNet (node hackcanton-01), idempotent:
 *
 *   pnpm --filter @lending/backend devnet:setup -- evm <custodyParty>
 *   pnpm --filter @lending/backend devnet:setup -- loop <custodyParty>
 *     LoopDirectory of operator and custodian: Loop wallet accounts (ADR-006)
 *     EvmDirectory of operator and custodian: EVM wallet accounts (ADR-004)
 *
 * Afterwards, in deployment.json: "evm": {"custody": …}. DevNet only.
 */
import { isPublicNetwork, loadConfig } from '../config.ts'
import { loadDeployment } from '../deployment.ts'
import { createRoleLedgers } from '../ledger/credentials.ts'
import { TEMPLATES } from '../ledger/ids.ts'

const [action, arg] = process.argv.slice(2).filter((a) => a !== '--')
const config = loadConfig()
if (isPublicNetwork(config.LEDGER_NETWORK))
  throw new Error('devnet-setup signs for council members: DevNet only')
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

async function setupEvm(custody: string) {
  if (!custody?.includes('::')) throw new Error('usage: evm <custodyParty>')
  const existing = await ledger.query<{ custody: string }>(d.operator, {
    templateId: TEMPLATES.evmDirectory,
  })
  if (existing.some((x) => x.payload.custody === custody)) {
    console.log('EvmDirectory exists')
  } else {
    const network = config.NETWORK_ID ?? 'canton:devnet'
    const r = await ledger.submit(
      [d.operator, custody],
      [
        {
          CreateCommand: {
            templateId: TEMPLATES.evmDirectory,
            createArguments: { operator: d.operator, custody, network, addresses: { map: [] } },
          },
        },
      ],
      [],
      [],
      { commandId: `evm-directory-${custody.slice(0, 40)}` },
    )
    console.log(`EvmDirectory created (${network}), updateId ${r.updateId}`)
  }
  console.log(`deployment.json: "evm": ${JSON.stringify({ custody })}`)
}

async function setupLoop(custody: string) {
  if (!custody?.includes('::')) throw new Error('usage: loop <custodyParty>')
  const existing = await ledger.query<{ custody: string }>(d.operator, {
    templateId: TEMPLATES.loopDirectory,
  })
  if (existing.some((x) => x.payload.custody === custody)) {
    console.log('LoopDirectory exists')
    return
  }
  const network = config.NETWORK_ID ?? 'canton:devnet'
  const r = await ledger.submit(
    [d.operator, custody],
    [
      {
        CreateCommand: {
          templateId: TEMPLATES.loopDirectory,
          createArguments: { operator: d.operator, custody, network, parties: { map: [] } },
        },
      },
    ],
    [],
    [],
    // idempotent: a repeated run will not create a second directory
    { commandId: `loop-directory-${custody.slice(0, 40)}` },
  )
  console.log(`LoopDirectory created (${network}), updateId ${r.updateId}`)
}

if (action === 'evm') await setupEvm(arg!)
else if (action === 'loop') await setupLoop(arg!)
else {
  console.error('usage: devnet-setup evm <custodyParty> | loop <custodyParty>')
  process.exit(2)
}
process.exit(0)
