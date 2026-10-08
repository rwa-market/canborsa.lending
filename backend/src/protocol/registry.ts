/**
 * Transfer factory and choice context for an instrument (canton-token-standard, CIP-0056).
 * The contract accepts only the factory from ProtocolConfig (audit K1), so the registry must
 * return exactly that one; otherwise reject before building the command.
 *
 * - ledger: TokenRules from splice-test-token-v1, found in the ACS as instrument.admin,
 *   empty context. DevNet only: the test token registries are protocol parties on our own node.
 * - http (B-2, A-10): the off-ledger Registry API of the instrument's registry
 *   `POST {url}/registry/transfer-instruction/v1/transfer-factory` → factoryId, choice context
 *   and disclosed contracts. For Amulet (CC) the url is the validator's scan-proxy, with the
 *   ledger token.
 */
import { INSTRUMENT_SLOTS } from '../config.ts'
import type { Deployment, Instrument } from '../deployment.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import { type DisclosedContract, type LedgerClient, toDisclosed } from '../ledger/client.ts'

export interface ExtraArgs {
  context: { values: Record<string, unknown> }
  meta: { values: Record<string, string> }
}

export const noExtraArgs = (): ExtraArgs => ({ context: { values: {} }, meta: { values: {} } })

export interface TransferFactory {
  factoryCid: string
  disclosed: DisclosedContract[]
  transferExtraArgs: ExtraArgs
  acceptExtraArgs: ExtraArgs
}

/**
 * Which transfer will be executed: the registry needs it for the choice context (receiver, amount).
 */
export interface TransferIntent {
  sender: string
  receiver: string
  amount: string
  inputHoldingCids?: string[]
}

/** Context for accepting an incoming TransferInstruction (CIP-0056 choice-contexts/accept). */
export interface AcceptContext {
  extraArgs: ExtraArgs
  disclosed: DisclosedContract[]
}

export interface TokenRegistry {
  transferFactory(
    instrument: Instrument,
    trustedCid: string,
    transfer?: TransferIntent,
  ): Promise<TransferFactory>
  /**
   * Accept context for an instruction; the ledger registry of test tokens returns an empty context.
   */
  acceptContext?(instrument: Instrument, instructionCid: string): Promise<AcceptContext>
  /** Withdraw context for one's own outgoing instruction (withdrawal reclaim, 0.6.0). */
  withdrawContext?(instrument: Instrument, instructionCid: string): Promise<AcceptContext>
}

export class RegistryError extends Error {}

export function ledgerRegistry(ledger: LedgerClient): TokenRegistry {
  return {
    async transferFactory(instrument, trustedCid) {
      const rules = await ledger.query(instrument.admin, { templateId: TEMPLATES.testTokenRules })
      const r = rules.find((x) => x.contractId === trustedCid)
      if (!r) throw new Error(`trusted factory for ${instrument.id} is not active`)
      return {
        factoryCid: r.contractId,
        disclosed: [toDisclosed(r)],
        transferExtraArgs: noExtraArgs(),
        acceptExtraArgs: noExtraArgs(),
      }
    },
    async acceptContext() {
      return { extraArgs: noExtraArgs(), disclosed: [] }
    },
    async withdrawContext() {
      return { extraArgs: noExtraArgs(), disclosed: [] }
    },
  }
}

export interface RegistryEndpoint {
  url: string
  /** ledger: the Authorization header of the operator credential (validator's scan-proxy) */
  auth?: 'none' | 'ledger'
}

interface FactoryResponse {
  factoryId?: string
  transferKind?: string
  choiceContext?: {
    choiceContextData?: { values?: Record<string, unknown> }
    disclosedContracts?: {
      templateId?: string
      contractId?: string
      createdEventBlob?: string
      synchronizerId?: string
    }[]
  }
}

/**
 * HTTP adapter for the Registry API. Checks are fail-closed: timeout, factoryId equals the trusted
 * factory from ProtocolConfig, every disclosed contract has a blob and a synchronizer.
 * Short cache by (instrument, sender, receiver): the Amulet context contains the round,
 * which changes every few minutes, so the cache lasts seconds.
 */
export function httpRegistry(opts: {
  endpoints: Partial<Record<string, RegistryEndpoint>>
  /** Instrument → slot usdcx | cc | cbtc (the registry is configured per slot, not per symbol) */
  slotOf: (i: Instrument) => string | undefined
  authHeader?: () => Promise<string | null>
  timeoutMs?: number
  cacheMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}): TokenRegistry {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a))
  const now = opts.now ?? Date.now
  const cache = new Map<string, { at: number; value: TransferFactory }>()

  return {
    async transferFactory(instrument, trustedCid, transfer) {
      const slot = opts.slotOf(instrument)
      const endpoint = slot ? opts.endpoints[slot] : undefined
      if (!endpoint) throw new RegistryError(`no registry URL for ${instrument.id}`)
      const cacheKey = JSON.stringify([
        instrument.admin,
        instrument.id,
        trustedCid,
        transfer?.sender,
        transfer?.receiver,
      ])
      const hit = cache.get(cacheKey)
      if (hit && now() - hit.at < (opts.cacheMs ?? 5_000)) return hit.value

      const at = new Date(now())
      const body = {
        choiceArguments: {
          expectedAdmin: instrument.admin,
          transfer: {
            sender: transfer?.sender ?? '',
            receiver: transfer?.receiver ?? '',
            amount: transfer?.amount ?? '0',
            instrumentId: { admin: instrument.admin, id: instrument.id },
            requestedAt: at.toISOString(),
            executeBefore: new Date(at.getTime() + 3_600_000).toISOString(),
            inputHoldingCids: transfer?.inputHoldingCids ?? [],
            meta: { values: {} },
          },
          extraArgs: noExtraArgs(),
        },
        excludeDebugFields: true,
      }
      const auth = endpoint.auth === 'ledger' ? await opts.authHeader?.() : null
      let res: Response
      try {
        res = await doFetch(
          `${endpoint.url.replace(/\/$/, '')}/registry/transfer-instruction/v1/transfer-factory`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(auth ? { authorization: auth } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
          },
        )
      } catch (err) {
        throw new RegistryError(`registry of ${instrument.id} did not answer: ${String(err)}`)
      }
      if (!res.ok) throw new RegistryError(`registry of ${instrument.id}: HTTP ${res.status}`)
      let r: FactoryResponse
      try {
        r = (await res.json()) as FactoryResponse
      } catch {
        throw new RegistryError(`registry of ${instrument.id}: response is not JSON`)
      }
      // Factory is not the one in ProtocolConfig: the contract would reject it, and a registry
      // substitution is an attack
      if (r.factoryId !== trustedCid)
        throw new RegistryError(
          `registry of ${instrument.id} returned an untrusted transfer factory`,
        )
      const disclosed = completeDisclosed(instrument, r.choiceContext?.disclosedContracts)
      const context = { values: r.choiceContext?.choiceContextData?.values ?? {} }
      const value: TransferFactory = {
        factoryCid: r.factoryId,
        disclosed,
        transferExtraArgs: { context, meta: { values: {} } },
        // Transfer and accept happen in one transaction: the instruction id is not known in
        // advance; the accept context of Token Standard registries is the same (rules and round) as
        // for the transfer.
        acceptExtraArgs: { context, meta: { values: {} } },
      }
      cache.set(cacheKey, { at: now(), value })
      return value
    },

    /**
     * `POST {url}/registry/transfer-instruction/v1/{cid}/choice-contexts/accept`: context and
     * disclosed contracts for TransferInstruction_Accept of an incoming transfer. No cache:
     * the context is bound to the instruction.
     */
    acceptContext: (instrument, instructionCid) =>
      choiceContext('accept', instrument, instructionCid),
    /** The same for `choice-contexts/withdraw`: reclaiming one's own outgoing instruction. */
    withdrawContext: (instrument, instructionCid) =>
      choiceContext('withdraw', instrument, instructionCid),
  }

  async function choiceContext(
    choice: 'accept' | 'withdraw',
    instrument: Instrument,
    instructionCid: string,
  ): Promise<AcceptContext> {
    const slot = opts.slotOf(instrument)
    const endpoint = slot ? opts.endpoints[slot] : undefined
    if (!endpoint) throw new RegistryError(`no registry URL for ${instrument.id}`)
    const auth = endpoint.auth === 'ledger' ? await opts.authHeader?.() : null
    let res: Response
    try {
      res = await doFetch(
        `${endpoint.url.replace(/\/$/, '')}/registry/transfer-instruction/v1/${encodeURIComponent(instructionCid)}/choice-contexts/${choice}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(auth ? { authorization: auth } : {}),
          },
          body: JSON.stringify({ meta: {}, excludeDebugFields: true }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
        },
      )
    } catch (err) {
      throw new RegistryError(`registry of ${instrument.id} did not answer: ${String(err)}`)
    }
    if (!res.ok) throw new RegistryError(`registry of ${instrument.id}: HTTP ${res.status}`)
    let r: FactoryResponse['choiceContext']
    try {
      r = (await res.json()) as FactoryResponse['choiceContext']
    } catch {
      throw new RegistryError(`registry of ${instrument.id}: response is not JSON`)
    }
    return {
      extraArgs: {
        context: { values: r?.choiceContextData?.values ?? {} },
        meta: { values: {} },
      },
      disclosed: completeDisclosed(instrument, r?.disclosedContracts),
    }
  }
}

function completeDisclosed(
  instrument: Instrument,
  list: NonNullable<FactoryResponse['choiceContext']>['disclosedContracts'],
): DisclosedContract[] {
  return (list ?? []).map((c) => {
    if (!c.templateId || !c.contractId || !c.createdEventBlob || !c.synchronizerId)
      throw new RegistryError(`registry of ${instrument.id}: incomplete disclosed contract`)
    return {
      templateId: c.templateId,
      contractId: c.contractId,
      createdEventBlob: c.createdEventBlob,
      synchronizerId: c.synchronizerId,
    }
  })
}

export function createRegistry(
  config: {
    TOKEN_REGISTRY: 'ledger' | 'http'
    TOKEN_REGISTRY_URLS: Partial<Record<string, string | RegistryEndpoint>>
    TOKEN_REGISTRY_TIMEOUT_MS: number
    TOKEN_REGISTRY_CACHE_MS: number
  },
  ledger: LedgerClient,
  d: Pick<Deployment, 'usdcx' | 'cc' | 'cbtc'>,
  authHeader?: () => Promise<string | null>,
): TokenRegistry {
  if (config.TOKEN_REGISTRY === 'ledger') return ledgerRegistry(ledger)
  const endpoints = Object.fromEntries(
    Object.entries(config.TOKEN_REGISTRY_URLS).map(([slot, e]) => [
      slot,
      typeof e === 'string' ? { url: e } : e,
    ]),
  )
  return httpRegistry({
    endpoints,
    slotOf: (i) => INSTRUMENT_SLOTS.find((s) => d[s]?.admin === i.admin && d[s]?.id === i.id),
    ...(authHeader ? { authHeader } : {}),
    timeoutMs: config.TOKEN_REGISTRY_TIMEOUT_MS,
    cacheMs: config.TOKEN_REGISTRY_CACHE_MS,
  })
}
