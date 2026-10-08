import type { InstrumentId, MarketId as SharedMarketId } from '@lending/shared'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const instrument = z.object({ admin: z.string(), id: z.string() })

/** Parties and instruments of the deployed protocol (scripts/devnet.py deploy, deployProd). */
export const deploymentSchema = z.object({
  operator: z.string(),
  oracle: z.string(),
  guardian: z.string(),
  treasury: z.string(),
  backstop: z.string(),
  liquidator: z.string(),
  alice: z.string().optional(),
  bob: z.string().optional(),
  carol: z.string().optional(),
  /** Test credentials Tester1…N (Deploy.daml) */
  testers: z.array(z.string()).default([]),
  /**
   * Council members (Deploy.daml, Deploy/Prod.daml). Optional: old deployment.json files without
   * the field are still read.
   */
  council: z.array(z.string()).default([]),
  usdcx: instrument,
  cc: instrument,
  cbtc: instrument,
  /**
   * EVM wallet accounts (0.5.0, ADR-004): the custodial party from which the backend submits
   * user-signed operations. Absent: EVM wallet sign-in is disabled.
   */
  evm: z.object({ custody: z.string() }).optional(),
})

export type Deployment = z.infer<typeof deploymentSchema>
/** The same InstrumentId as in shared (A-7): the zod schema cannot diverge from the shared type. */
export type Instrument = InstrumentId
const _instrumentMatches: z.infer<typeof instrument> extends InstrumentId
  ? InstrumentId extends z.infer<typeof instrument>
    ? true
    : never
  : never = true
void _instrumentMatches

export function loadDeployment(path: string): Deployment {
  return deploymentSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** All markets the code knows, in display order. */
export const MARKETS = ['CC', 'CBTC'] as const satisfies readonly SharedMarketId[]
export type MarketId = SharedMarketId

/** Market slot in deployment.json: CC → cc. */
export const marketSlot = (m: MarketId) => m.toLowerCase() as 'cc' | 'cbtc'

/** Markets of this deployment. */
export function marketsOf(d: Deployment): MarketId[] {
  return MARKETS.filter((m) => !!d[marketSlot(m)])
}

export function marketInstrument(d: Deployment, marketId: MarketId): Instrument {
  const i = d[marketSlot(marketId)]
  if (!i) throw new Error(`market ${marketId} is not deployed`)
  return i
}

/** Protocol instruments by symbol: USDCx and the collateral of the deployment's markets. */
export function instrumentsOf(d: Deployment): Partial<Record<'USDCx' | MarketId, Instrument>> {
  return {
    USDCx: d.usdcx,
    ...Object.fromEntries(marketsOf(d).map((m) => [m, marketInstrument(d, m)])),
  }
}
