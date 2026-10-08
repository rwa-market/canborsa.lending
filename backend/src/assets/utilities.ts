/**
 * DA Utilities backend: burn-mint factory USDCx (guidance.mdx, "Extracting Contract IDs and
 * Disclosed Contracts") [V]. One call returns factoryCid, contextContractIds and disclosed
 * contracts for both BridgeUserAgreement_Mint and BridgeUserAgreement_Burn.
 */
import type { Instrument } from '../deployment.ts'
import type { DisclosedContract } from '../ledger/client.ts'
import { RegistryError } from '../protocol/registry.ts'

export interface BurnMintContext {
  factoryCid: string
  contextContractIds: {
    instrumentConfigurationCid: string
    appRewardConfigurationCid: string
    featuredAppRightCid: string
  }
  disclosed: DisclosedContract[]
}

export interface BurnMintFactory {
  context(
    instrument: Instrument,
    inputHoldingCids: string[],
    outputs: { owner: string; amount: string }[],
  ): Promise<BurnMintContext>
}

const KEYS = {
  instrumentConfigurationCid: 'utility.digitalasset.com/instrument-configuration',
  appRewardConfigurationCid: 'utility.digitalasset.com/app-reward-configuration',
  featuredAppRightCid: 'utility.digitalasset.com/featured-app-right',
} as const

interface Raw {
  factoryId?: string
  choiceContext?: {
    choiceContextData?: { values?: Record<string, { value?: unknown } | undefined> }
    disclosedContracts?: Partial<DisclosedContract>[]
  }
  httpResponse?: { body?: Raw }
}

export function httpBurnMintFactory(opts: {
  backendUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): BurnMintFactory {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a))
  return {
    async context(instrument, inputHoldingCids, outputs) {
      let res: Response
      try {
        res = await doFetch(
          `${opts.backendUrl.replace(/\/$/, '')}/api/utilities/v0/registry/burn-mint-instruction/v0/burn-mint-factory`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              instrumentId: { admin: instrument.admin, id: instrument.id },
              inputHoldingCids,
              outputs,
            }),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
          },
        )
      } catch (err) {
        throw new RegistryError(`DA Utilities did not answer: ${String(err)}`)
      }
      if (!res.ok) throw new RegistryError(`DA Utilities burn-mint-factory: HTTP ${res.status}`)
      let raw: Raw
      try {
        raw = (await res.json()) as Raw
      } catch {
        throw new RegistryError('DA Utilities burn-mint-factory: response is not JSON')
      }
      const body = raw.httpResponse?.body ?? raw
      const values = body.choiceContext?.choiceContextData?.values ?? {}
      const pick = (k: string) => {
        const v = values[k]?.value
        if (typeof v !== 'string' || !v)
          throw new RegistryError(`DA Utilities burn-mint-factory: no ${k} in the context`)
        return v
      }
      if (!body.factoryId) throw new RegistryError('DA Utilities burn-mint-factory: no factoryId')
      const disclosed = (body.choiceContext?.disclosedContracts ?? []).map((c) => {
        if (!c.templateId || !c.contractId || !c.createdEventBlob || !c.synchronizerId)
          throw new RegistryError('DA Utilities burn-mint-factory: incomplete disclosed contract')
        return {
          templateId: c.templateId,
          contractId: c.contractId,
          createdEventBlob: c.createdEventBlob,
          synchronizerId: c.synchronizerId,
        }
      })
      return {
        factoryCid: body.factoryId,
        contextContractIds: {
          instrumentConfigurationCid: pick(KEYS.instrumentConfigurationCid),
          appRewardConfigurationCid: pick(KEYS.appRewardConfigurationCid),
          featuredAppRightCid: pick(KEYS.featuredAppRightCid),
        },
        disclosed,
      }
    },
  }
}
