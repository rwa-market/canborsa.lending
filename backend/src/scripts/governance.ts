/**
 * Council actions whose controller is the operator (lending-governance 0.4.0). The HTTP API
 * does not expose them: the operator executes them deliberately, with its own ledger credential.
 *
 *   pnpm --filter @lending/backend gov -- list
 *   pnpm --filter @lending/backend gov -- trusted <proposalId> --confirm <proposalId>
 *   pnpm --filter @lending/backend gov -- rotation <rotationId> --confirm <rotationId>
 *
 * trusted: Proposal_ExecuteTrusted: changing roles, factories, Featured App rights, disabling
 * attestation; requires the council approval threshold (D-5).
 * rotation: Rotation_Execute by the operator: forming the first council after deployProd
 * (councilHostedHere = false), once all members have signed Rotation_Join (seam 10).
 */
import { loadConfig, isPublicNetwork } from '../config.ts'
import { loadDeployment } from '../deployment.ts'
import { createRoleLedgers } from '../ledger/credentials.ts'
import { createGovernance } from '../protocol/governance.ts'
import { createReader } from '../protocol/reader.ts'
import { createRegistry } from '../protocol/registry.ts'

const [action, id, flag, confirm] = process.argv.slice(2).filter((a) => a !== '--')
const config = loadConfig()
const deployment = loadDeployment(config.DEPLOYMENT_PATH)
const roleLedgers = await createRoleLedgers(
  {
    LEDGER_API_URL: config.LEDGER_API_URL,
    LEDGER_PAGE_SIZE: config.LEDGER_PAGE_SIZE,
    LEDGER_MAX_PAGES: config.LEDGER_MAX_PAGES,
    credentials: config.credentials,
    publicNetwork: isPublicNetwork(config.LEDGER_NETWORK),
  },
  deployment,
)
const ledger = roleLedgers.ledger
const reader = createReader(ledger, deployment)
const operatorToken = roleLedgers.tokens.operator ?? roleLedgers.tokens.default
const registry = createRegistry(
  config,
  ledger,
  deployment,
  operatorToken ? () => operatorToken.header() : undefined,
)
const gov = createGovernance(deployment, reader, registry)

if (action === 'list' || !action) {
  console.log(JSON.stringify(await gov.view(), null, 2))
  process.exit(0)
}
if (!id || flag !== '--confirm' || confirm !== id) {
  console.error(`usage: gov ${action} <id> --confirm <id>  (repeat the id to confirm)`)
  process.exit(2)
}
const view = await gov.view()
let prepared
if (action === 'trusted') {
  const p = view.proposals.find((x) => x.proposalId === id)
  console.log('proposal:', JSON.stringify(p, null, 2))
  prepared = await gov.executeTrusted(id)
} else if (action === 'rotation') {
  const r = view.rotations.find((x) => x.rotationId === id)
  if (!r) throw new Error(`rotation ${id} not found`)
  console.log('rotation:', JSON.stringify(r, null, 2))
  prepared = await gov.executeRotation(deployment.operator, r.contractId)
} else {
  console.error(`unknown action ${action}: list | trusted | rotation`)
  process.exit(2)
}
const result = await ledger.submit(prepared.actAs, prepared.commands, prepared.disclosedContracts)
console.log(`${action} ${id}: executed, updateId ${result.updateId}`)
