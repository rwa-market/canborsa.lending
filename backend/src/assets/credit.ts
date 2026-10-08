/**
 * Crediting a deposit to an EVM wallet with custodian holdings: EvmWallet_CreditDeposit
 * (lending-core 0.6.0). One path for three sources:
 *
 * - xReserve: depositRef = Ethereum transaction hash (claims.ts);
 * - CC via TransferPreapproval: depositRef = "<updateId>:<nodeId>" of the transfer node
 *   (custody-tx.ts);
 * - refund of a withdrawal that did not reach the recipient (Reject etc.): depositRef =
 *   "refund:<transferCid>".
 *
 * Retries are cut off by three layers: DepositRegistry.refs on the ledger (the contract rejects
 * `deposit already credited` for the same and for another wallet), commandId from depositRef, and a
 * refs check before submitting. The contract does not spend the holdings: they only prove that the
 * custodian has free tokens for the amount, so any free holdings of the instrument will do.
 */
import type { Instrument } from '../deployment.ts'
import {
  classifyLedgerError,
  type DisclosedContract,
  type LedgerClient,
  toDisclosed,
} from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import { selectInputs } from '../protocol/commands.ts'
import { sha } from '../protocol/evm.ts'
import { dec } from '../protocol/math.ts'
import type { Reader } from '../protocol/reader.ts'

/** Credit not possible yet, but a retry will help: account not open, holdings not visible yet. */
export class CreditNotReadyError extends Error {}

/** No DepositRegistry: setup was not done (assets:setup-registry). */
export class NoDepositRegistryError extends Error {
  constructor() {
    super('No DepositRegistry for the custody party: run assets:setup-registry')
  }
}

export type CreditOutcome = { state: 'credited'; updateId: string } | { state: 'already' }

/** DA.Set Text in the JSON API: {map: [[k, {}]]} or a list. */
export const setHas = (refs: unknown, key: string): boolean => {
  if (Array.isArray(refs)) return refs.includes(key)
  const m = (refs as { map?: unknown[] } | null)?.map
  return Array.isArray(m) && m.some((e) => (Array.isArray(e) ? e[0] === key : e === key))
}

export interface CreditDeps {
  ledger: LedgerClient
  reader: Pick<Reader, 'snapshot' | 'holdings' | 'evmWallet'>
  /** Open the address account if it does not exist (EvmDirectory_Open) */
  ensureAccount: (address: string) => Promise<unknown>
  operator: string
  custody: string
}

export interface CreditRequest {
  address: string
  instrument: Instrument
  amount: string
  depositRef: string
  /** commandId; defaults to `evm-credit-<sha(depositRef)>` */
  commandId?: string
}

/** Whether depositRef is already credited: reads the custodian's DepositRegistry. */
export async function depositRegistry(deps: Pick<CreditDeps, 'ledger' | 'operator' | 'custody'>) {
  const registries = await deps.ledger.query<{ operator: string; custody: string; refs: unknown }>(
    deps.custody,
    { templateId: TEMPLATES.depositRegistry },
  )
  return (
    registries.find(
      (r) => r.payload.operator === deps.operator && r.payload.custody === deps.custody,
    ) ?? null
  )
}

export async function creditDeposit(deps: CreditDeps, req: CreditRequest): Promise<CreditOutcome> {
  const { ledger, custody } = deps
  const registry = await depositRegistry(deps)
  if (!registry) throw new NoDepositRegistryError()
  if (setHas(registry.payload.refs, req.depositRef)) return { state: 'already' }
  await deps.ensureAccount(req.address)
  const wallet = await deps.reader.evmWallet(req.address)
  if (!wallet) throw new CreditNotReadyError('The EVM account is not open yet, try again')
  const s = await deps.reader.snapshot()
  const held = await deps.reader.holdings(custody, req.instrument)
  let inputs: string[]
  try {
    inputs = selectInputs(held, req.amount)
  } catch {
    throw new CreditNotReadyError(
      `The deposited ${req.instrument.id} is not visible yet, try again`,
    )
  }
  const disclosed: DisclosedContract[] = [toDisclosed(s.config)]
  try {
    const r = await ledger.submit(
      [custody],
      [
        {
          ExerciseCommand: {
            templateId: TEMPLATES.evmWallet,
            contractId: wallet.contractId,
            choice: 'EvmWallet_CreditDeposit',
            choiceArgument: {
              configCid: s.config.contractId,
              registryCid: registry.contractId,
              holdingCids: inputs,
              instrumentId: { admin: req.instrument.admin, id: req.instrument.id },
              amount: dec(req.amount).toFixed(),
              depositRef: req.depositRef,
            },
          },
        },
      ],
      disclosed,
      [],
      { commandId: req.commandId ?? `evm-credit-${sha(req.depositRef)}` },
    )
    return { state: 'credited', updateId: r.updateId }
  } catch (err) {
    const text = `${String(err)} ${(err as { publicText?: string }).publicText ?? ''}`
    if (classifyLedgerError(err) === 'duplicate' || /deposit already credited/.test(text))
      return { state: 'already' }
    throw err
  }
}
