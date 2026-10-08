import { staticToken, type TokenSource } from './token.ts'
import { createHash } from 'node:crypto'

/** ACS contract with what is needed for reading and for explicit disclosure. */
export interface ActiveContract<T = unknown> {
  contractId: string
  templateId: string
  payload: T
  createdEventBlob: string
  synchronizerId: string
  interfaceView?: unknown
}

/** Contract for the command's disclosedContracts field (canton-explicit-disclosure). */
export interface DisclosedContract {
  templateId: string
  contractId: string
  createdEventBlob: string
  synchronizerId: string
}

export type Command =
  | { CreateCommand: { templateId: string; createArguments: unknown } }
  | {
      ExerciseCommand: {
        templateId: string
        contractId: string
        choice: string
        choiceArgument: unknown
      }
    }

export interface TransactionEvent {
  CreatedEvent?: { contractId: string; templateId: string; createArgument: unknown }
  ArchivedEvent?: { contractId: string; templateId: string }
  ExercisedEvent?: { contractId: string; choice: string; exerciseResult: unknown }
}

/** Ledger effects transaction event (JSON API v2): nodeId defines the tree. */
export interface LedgerTxEvent {
  CreatedEvent?: {
    nodeId: number
    contractId: string
    templateId: string
    createArgument?: unknown
    interfaceViews?: { interfaceId?: string; viewValue?: unknown }[] | null
  }
  ExercisedEvent?: {
    nodeId: number
    lastDescendantNodeId: number
    contractId: string
    templateId: string
    interfaceId?: string | null
    choice: string
    choiceArgument?: unknown
    exerciseResult?: unknown
    consuming: boolean
    implementedInterfaces?: string[] | null
  }
  ArchivedEvent?: { nodeId: number; contractId: string; templateId: string }
}

export interface LedgerTransaction {
  updateId: string
  offset: number
  events: LedgerTxEvent[]
}

export interface SubmitResult {
  updateId: string
  events: TransactionEvent[]
}

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    /**
     * What can be shown to the client: the contract's rejection text or an error code (audit S7).
     */
    readonly publicText: string,
  ) {
    super(message)
  }
}

/**
 * The ledger did not respond: network, timeout, dropped connection (A-8, I-20). Not a contract
 * rejection: the submission may have gone through; a retry with the same commandId is deduplicated.
 */
export class LedgerUnavailableError extends LedgerError {
  constructor(message: string) {
    super(
      message,
      0,
      null,
      'UNAVAILABLE: the ledger did not answer in time, try again (the command may still be processed)',
    )
  }
}

export interface SubmitOptions {
  /** Domain key of the command; defaults to a hash of the user, actAs and commands (B-15). */
  commandId?: string
}

/**
 * What a submission error means (A-8):
 * - transient: network, timeout, overload, contention on a contract: retry later;
 * - duplicate: the ledger already accepted a command with this commandId: the result is there
 *   or will come;
 * - rejected: contract or request rejection: a retry will not help.
 */
export type LedgerFailure = 'transient' | 'duplicate' | 'rejected'

const DUPLICATE = /DUPLICATE_COMMAND|SUBMISSION_ALREADY_IN_FLIGHT|ALREADY_EXISTS/i
const TRANSIENT =
  /locked contracts|LOCKED_CONTRACTS|SEQUENCER_BACKPRESSURE|ABORTED_DUE_TO_SHUTDOWN|UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|HTTP (?:409|429|502|503|504)|timed? ?out|TimeoutError|aborted due to timeout|operation was aborted|fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed|NOT_CONNECTED_TO_ANY_SYNCHRONIZER/i

export function classifyLedgerError(err: unknown): LedgerFailure {
  if (err instanceof LedgerUnavailableError) return 'transient'
  const text = String(err instanceof Error ? err.message : err)
  if (DUPLICATE.test(text)) return 'duplicate'
  if (TRANSIENT.test(text)) return 'transient'
  return 'rejected'
}

/** Deterministic commandId: the same logical bot step yields the same id (B-15). */
export function commandIdOf(userId: string, actAs: string[], commands: Command[]): string {
  const h = createHash('sha256')
    .update(JSON.stringify([userId, [...actAs].sort(), commands]))
    .digest('hex')
  return `lending-${h.slice(0, 40)}`
}

const CONTRACT_GONE =
  /CONTRACT_NOT_FOUND|LOCAL_VERDICT_INACTIVE|INCONSISTENT_CONTRACT|contract.*not.*(found|active)|inactive contracts/i

/** Text for the client: the Daml abort message or the error class without internal details. */
const POOL_BUSY =
  /locked contracts|LOCKED_CONTRACTS|SEQUENCER_BACKPRESSURE|ABORTED_DUE_TO_SHUTDOWN/i

export function publicMessage(cause: string): string {
  const aborts = [
    ...cause.matchAll(
      /GeneralError(?: \(error category \d+\))?: ([^\n"]{1,200}?)(?:\s+Using Canton|["\n]|$)/g,
    ),
  ]
  const text = aborts.at(-1)?.[1]?.trim()
  if (text) return text
  if (CONTRACT_GONE.test(cause)) return 'STALE_CONTRACT: state changed, prepare the command again'
  // One pool for everyone: concurrent transactions conflict, a retry succeeds (audit C8)
  if (POOL_BUSY.test(cause)) return 'BUSY: the pool is processing other transactions, try again'
  return 'The ledger rejected the command'
}

interface RawActiveContract {
  contractEntry?: {
    JsActiveContract?: {
      synchronizerId: string
      createdEvent: {
        contractId: string
        templateId: string
        createArgument: unknown
        createdEventBlob: string
        interfaceViews?: { viewValue?: unknown }[] | null
      }
    }
  }
}

interface ActiveContractsPage {
  activeContracts?: RawActiveContract[]
  activeAtOffset?: number
  nextPageToken?: string | null
}

/** JSON Ledger API v2 client (canton-json-api). */
export function createLedgerClient(
  config: {
    LEDGER_API_URL: string
    LEDGER_USER_ID?: string | undefined
    /** ACS page size (B-4) */
    LEDGER_PAGE_SIZE?: number
    /** More pages is an error, not an endless read */
    LEDGER_MAX_PAGES?: number
  },
  tokens: TokenSource = staticToken(),
  fetchImpl: typeof fetch = (...args) => fetch(...args),
) {
  // Ledger user: explicit LEDGER_USER_ID, else the token's sub (OIDC nodes), else a participant
  // without auth
  const userId = config.LEDGER_USER_ID ?? tokens.subject() ?? 'lending-backend'
  const pageSize = config.LEDGER_PAGE_SIZE ?? 500
  const maxPages = config.LEDGER_MAX_PAGES ?? 200
  /** Node without active-contracts-page (old Canton): read with the old method */
  let legacyAcs = false

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    const send = async (force: boolean) => {
      const auth = await tokens.header(force)
      try {
        return await fetchImpl(new URL(path, config.LEDGER_API_URL), {
          method,
          headers: {
            'content-type': 'application/json',
            ...(auth ? { authorization: auth } : {}),
          },
          body: body === undefined ? null : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        // Timeout and dropped connection are not a contract rejection (A-8): separate error class
        const e = err as { name?: string; message?: string; cause?: { code?: string } }
        throw new LedgerUnavailableError(
          `${method} ${path}: ${e.name ?? 'Error'}: ${e.message ?? String(err)}${e.cause?.code ? ` (${e.cause.code})` : ''}`,
        )
      }
    }
    let res = await send(false)
    // Token revoked or expired early: one retry with a new one
    if (res.status === 401) res = await send(true)
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      // a proxy in front of the node returned HTML or text
      parsed = null
    }
    if (!res.ok) {
      const cause = (parsed as { cause?: string } | null)?.cause ?? text
      throw new LedgerError(
        `${method} ${path}: HTTP ${res.status}: ${cause}`,
        res.status,
        parsed,
        publicMessage(cause),
      )
    }
    if (text && parsed === null)
      throw new LedgerUnavailableError(`${method} ${path}: HTTP ${res.status}: not JSON`)
    return parsed as T
  }

  async function ledgerEnd(): Promise<number> {
    const r = await call<{ offset: number }>('GET', '/v2/state/ledger-end')
    return r.offset
  }

  /**
   * Up to which offset the node has pruned history. On the shared DevNet node, reading updates
   * before this boundary is rejected: "precedes pruned offset".
   */
  async function prunedOffset(): Promise<number> {
    const r = await call<{ participantPrunedUpToInclusive?: number }>(
      'GET',
      '/v2/state/latest-pruned-offsets',
    )
    return r.participantPrunedUpToInclusive ?? 0
  }

  const toActive = <T>(raw: RawActiveContract[]): ActiveContract<T>[] =>
    raw.flatMap((r) => {
      const a = r.contractEntry?.JsActiveContract
      if (!a) return []
      const e = a.createdEvent
      return [
        {
          contractId: e.contractId,
          templateId: e.templateId,
          payload: e.createArgument as T,
          createdEventBlob: e.createdEventBlob,
          synchronizerId: a.synchronizerId,
          interfaceView: e.interfaceViews?.[0]?.viewValue,
        },
      ]
    })

  /**
   * Active contracts of a party by template or interface. Paginated (B-4, I-20):
   * /v2/state/active-contracts-page with LEDGER_PAGE_SIZE, all pages at one offset.
   * A node without this method (404): the old /v2/state/active-contracts.
   */
  async function query<T>(
    party: string,
    filter: { templateId: string } | { interfaceId: string },
  ): Promise<ActiveContract<T>[]> {
    const identifierFilter =
      'templateId' in filter
        ? {
            TemplateFilter: {
              value: { templateId: filter.templateId, includeCreatedEventBlob: true },
            },
          }
        : {
            InterfaceFilter: {
              value: {
                interfaceId: filter.interfaceId,
                includeInterfaceView: true,
                includeCreatedEventBlob: true,
              },
            },
          }
    const filtersByParty = { [party]: { cumulative: [{ identifierFilter }] } }
    if (!legacyAcs) {
      try {
        const out: ActiveContract<T>[] = []
        let pageToken: string | undefined
        let activeAtOffset: number | undefined
        for (let page = 0; ; page++) {
          if (page >= maxPages)
            throw new Error(
              `ACS of ${party.split('::')[0]} exceeds ${maxPages} pages of ${pageSize}: raise LEDGER_MAX_PAGES`,
            )
          const r = await call<ActiveContractsPage>('POST', '/v2/state/active-contracts-page', {
            eventFormat: { filtersByParty, verbose: false },
            maxPageSize: pageSize,
            ...(activeAtOffset !== undefined ? { activeAtOffset } : {}),
            ...(pageToken ? { pageToken } : {}),
          })
          out.push(...toActive<T>(r.activeContracts ?? []))
          activeAtOffset ??= r.activeAtOffset
          if (!r.nextPageToken) return out
          pageToken = r.nextPageToken
        }
      } catch (err) {
        if (!(err instanceof LedgerError && err.status === 404)) throw err
        legacyAcs = true
      }
    }
    const raw = await call<RawActiveContract[]>('POST', '/v2/state/active-contracts', {
      filter: { filtersByParty },
      verbose: false,
      activeAtOffset: await ledgerEnd(),
    })
    return toActive<T>(raw)
  }

  /** Participant id: the indexer stores it in the checkpoint (B-11, A-19). */
  async function participantId(): Promise<string> {
    const r = await call<{ participantId: string }>('GET', '/v2/parties/participant-id')
    return r.participantId
  }

  async function submit(
    actAs: string[],
    commands: Command[],
    disclosedContracts: DisclosedContract[] = [],
    readAs: string[] = [],
    options: SubmitOptions = {},
  ): Promise<SubmitResult> {
    const r = await call<{ transaction: { updateId: string; events: TransactionEvent[] } }>(
      'POST',
      '/v2/commands/submit-and-wait-for-transaction',
      {
        commands: {
          commands,
          // the same bot step after a timeout gets the same id: the ledger deduplicates it (B-15)
          commandId: options.commandId ?? commandIdOf(userId, actAs, commands),
          userId,
          actAs,
          readAs,
          disclosedContracts,
        },
      },
      60_000,
    )
    return { updateId: r.transaction.updateId, events: r.transaction.events }
  }

  /**
   * Transactions (ledger effects) visible to the party, by template. Also returns the offset of the
   * last page element, checkpoints included: the cursor follows it, not the transactions
   * (audit S2).
   */
  async function updates(
    party: string,
    templateIds: string[],
    beginExclusive: number,
    endInclusive: number,
    limit: number,
    /** Interfaces: e.g. TransferFactory, to see executed transfer amounts. */
    interfaceIds: string[] = [],
  ): Promise<{ transactions: { offset: number }[]; lastOffset: number | null; count: number }> {
    const raw = await call<{ update: Record<string, { value: { offset?: number } }> }[]>(
      'POST',
      `/v2/updates?limit=${limit}`,
      {
        beginExclusive,
        endInclusive,
        updateFormat: {
          includeTransactions: {
            transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
            eventFormat: {
              filtersByParty: {
                [party]: {
                  cumulative: [
                    ...templateIds.map((templateId) => ({
                      identifierFilter: { TemplateFilter: { value: { templateId } } },
                    })),
                    ...interfaceIds.map((interfaceId) => ({
                      identifierFilter: {
                        InterfaceFilter: { value: { interfaceId, includeInterfaceView: false } },
                      },
                    })),
                  ],
                },
              },
              verbose: false,
            },
          },
        },
      },
      60_000,
    )
    let lastOffset: number | null = null
    const transactions: { offset: number }[] = []
    for (const r of raw) {
      const [kind, body] = Object.entries(r.update)[0] ?? []
      const offset = body?.value?.offset
      if (typeof offset === 'number') lastOffset = Math.max(lastOffset ?? 0, offset)
      if (kind === 'Transaction' && body) transactions.push(body.value as { offset: number })
    }
    return { transactions, lastOffset, count: raw.length }
  }

  /**
   * Full party transactions (ledger effects): all events visible to it, with nodeId and
   * lastDescendantNodeId, Holding and TransferInstruction views. Needed to parse custodian
   * deposits (real assets): the transfer memo and the holdings created under it.
   */
  async function transactions(
    party: string,
    beginExclusive: number,
    endInclusive: number,
    limit: number,
    interfaceIds: string[] = [],
  ): Promise<{ transactions: LedgerTransaction[]; lastOffset: number | null; count: number }> {
    const raw = await call<{ update: Record<string, { value: LedgerTransaction }> }[]>(
      'POST',
      `/v2/updates?limit=${limit}`,
      {
        beginExclusive,
        endInclusive,
        updateFormat: {
          includeTransactions: {
            transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
            eventFormat: {
              filtersByParty: {
                [party]: {
                  cumulative: [
                    {
                      identifierFilter: {
                        WildcardFilter: { value: { includeCreatedEventBlob: false } },
                      },
                    },
                    ...interfaceIds.map((interfaceId) => ({
                      identifierFilter: {
                        InterfaceFilter: {
                          value: {
                            interfaceId,
                            includeInterfaceView: true,
                            includeCreatedEventBlob: false,
                          },
                        },
                      },
                    })),
                  ],
                },
              },
              verbose: false,
            },
          },
        },
      },
      60_000,
    )
    let lastOffset: number | null = null
    const out: LedgerTransaction[] = []
    for (const r of raw) {
      const [kind, body] = Object.entries(r.update)[0] ?? []
      const offset = body?.value?.offset
      if (typeof offset === 'number') lastOffset = Math.max(lastOffset ?? 0, offset)
      if (kind === 'Transaction' && body) out.push(body.value)
    }
    return { transactions: out, lastOffset, count: raw.length }
  }

  /**
   * Contract create event by id (`/v2/events/events-by-contract-id`) with the interface view.
   * Contract not visible to the party: null (404).
   */
  async function createdEvent(
    party: string,
    contractId: string,
    interfaceId: string,
  ): Promise<{ contractId: string; interfaceView: unknown; createArgument: unknown } | null> {
    try {
      const r = await call<{
        created?: {
          createdEvent?: {
            contractId: string
            createArgument?: unknown
            interfaceViews?: { viewValue?: unknown }[] | null
          }
        }
      }>('POST', '/v2/events/events-by-contract-id', {
        contractId,
        eventFormat: {
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    InterfaceFilter: {
                      value: {
                        interfaceId,
                        includeInterfaceView: true,
                        includeCreatedEventBlob: false,
                      },
                    },
                  },
                },
              ],
            },
          },
          verbose: false,
        },
      })
      const e = r.created?.createdEvent
      if (!e) return null
      return {
        contractId: e.contractId,
        interfaceView: e.interfaceViews?.[0]?.viewValue,
        createArgument: e.createArgument,
      }
    } catch (err) {
      if (err instanceof LedgerError && err.status === 404) return null
      throw err
    }
  }

  async function version(timeoutMs = 2000): Promise<string | null> {
    try {
      const r = await call<{ version?: string }>('GET', '/v2/version', undefined, timeoutMs)
      return r.version ?? null
    } catch {
      return null
    }
  }

  return {
    ledgerEnd,
    prunedOffset,
    participantId,
    query,
    submit,
    updates,
    transactions,
    createdEvent,
    version,
  }
}

export type LedgerClient = ReturnType<typeof createLedgerClient>

export function toDisclosed(c: ActiveContract): DisclosedContract {
  return {
    templateId: c.templateId,
    contractId: c.contractId,
    createdEventBlob: c.createdEventBlob,
    synchronizerId: c.synchronizerId,
  }
}

/** contractId of the template contract created in the transaction (by Module:Entity suffix). */
export function createdOf(result: SubmitResult, templateSuffix: string): string[] {
  return result.events.flatMap((e) =>
    e.CreatedEvent && e.CreatedEvent.templateId.endsWith(templateSuffix)
      ? [e.CreatedEvent.contractId]
      : [],
  )
}
