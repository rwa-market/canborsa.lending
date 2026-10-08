/**
 * xReserve deposit claim (seam 2): POST /evm/claim-deposit {txHash} with the address session.
 *
 * A USDC deposit from MetaMask arrives on Canton as a DepositAttestation to the custodian party;
 * xReserve has no memo. Only the Ethereum transaction shows whose it is: its sender.
 * So the backend checks the tx itself (xreserve.ts), picks an unused attestation for
 * the same amount and performs two steps as the custodian:
 *
 *   1. BridgeUserAgreement_Mint: USDCx is minted to the custodian (claim → minted);
 *   2. EvmWallet_CreditDeposit { depositRef = txHash }: the amount lands in the address wallet
 *      (claim → credited). The contract keeps a DepositRegistry: one hash, one credit.
 *
 * Retry: hash is the PRIMARY KEY, attestation is UNIQUE (store.ts), commandId derives from hash; a
 * claim in status minted resumes from step 2 on retry. A step 2 failure goes to the quarantine
 * minted-not-credited: the money is with the custodian, address and amount are pinned to the hash.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Instrument } from '../deployment.ts'
import { classifyLedgerError, LedgerError, type LedgerClient } from '../ledger/client.ts'
import type { Metrics } from '../metrics.ts'
import { dec } from '../protocol/math.ts'
import { sha } from '../protocol/evm.ts'
import type { Reader } from '../protocol/reader.ts'
import {
  BRIDGE_TEMPLATES,
  fromUnits,
  toUnits,
  USDC_DECIMALS,
  type XreserveProfile,
} from './profiles.ts'
import { creditDeposit, CreditNotReadyError, NoDepositRegistryError } from './credit.ts'
import type { RealAssetsStore } from './store.ts'
import type { BurnMintFactory } from './utilities.ts'
import { ClaimError, type EthRpc, verifyXreserveDeposit } from './xreserve.ts'

export interface ClaimResult {
  txHash: string
  amount: string
  status: 'credited' | 'minted'
}

/** What can be read from a DepositAttestation: the fields are unpublished (research §2 [?]). */
export function attestationView(payload: unknown): {
  amount: string | null
  parties: string[]
  hashes: string[]
} {
  const p = (payload ?? {}) as Record<string, unknown>
  const amountRaw = p.amount ?? p.value ?? p.quantity
  const amount = typeof amountRaw === 'string' && /^\d+(\.\d+)?$/.test(amountRaw) ? amountRaw : null
  const parties: string[] = []
  for (const k of ['recipient', 'user', 'owner', 'beneficiary', 'receiver'])
    if (typeof p[k] === 'string') parties.push(p[k] as string)
  const hashes: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return
    if (typeof v === 'string') {
      if (/^(0x)?[0-9a-fA-F]{64}$/.test(v))
        hashes.push(v.startsWith('0x') ? v.toLowerCase() : `0x${v.toLowerCase()}`)
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1))
  }
  walk(p, 0)
  return { amount, parties, hashes }
}

export function createXreserveClaims(deps: {
  ledger: LedgerClient
  reader: Pick<Reader, 'snapshot' | 'holdings' | 'evmWallet'>
  /** Open the address account if it does not exist (EvmDirectory_Open) */
  ensureAccount: (address: string) => Promise<unknown>
  operator: string
  store: RealAssetsStore
  rpc: EthRpc
  burnMint: BurnMintFactory
  custody: string
  usdcx: Instrument
  xreserve: XreserveProfile
  minConfirmations: number
  depositEvent?: string | undefined
  metrics?: Metrics
  log?: FastifyBaseLogger
}) {
  const { ledger, store, custody } = deps
  const count = (outcome: string) =>
    deps.metrics?.inc('xreserve_claims_total', 'Claims of xReserve deposits by outcome', {
      outcome,
    })

  async function claim(address: string, txHash: string): Promise<ClaimResult> {
    const begun = store.beginClaim(txHash, address)
    const prior = begun === 'ALREADY_CLAIMED' ? store.claim(txHash) : null
    // Minted but not credited (failure between steps): the same address resumes from step 2
    if (prior?.status === 'minted' && prior.address === address && prior.amount)
      return creditStep(address, txHash, prior.amount)
    if (begun !== 'ok') {
      count(begun.toLowerCase())
      throw new ClaimError(
        begun,
        begun === 'ALREADY_CLAIMED'
          ? 'This deposit was already claimed'
          : 'This deposit is being claimed right now, try again in a minute',
      )
    }
    let keep = false
    try {
      const v = await verifyXreserveDeposit(deps.rpc, {
        txHash,
        address,
        custody,
        xreserve: deps.xreserve,
        minConfirmations: deps.minConfirmations,
        depositEvent: deps.depositEvent,
      })
      const attestations = await ledger.query(custody, {
        templateId: BRIDGE_TEMPLATES.depositAttestation,
      })
      const own = store.claim(txHash)?.attestation_cid ?? null
      const used = store.usedAttestations()
      if (own) used.delete(own)
      // Our attestation is already consumed: the previous mint went through, the ledger outcome
      // never reached us
      if (own && !attestations.some((a) => a.contractId === own)) {
        const amount = store.claim(txHash)!.amount!
        store.setClaimStatus(txHash, 'minted', null)
        keep = true
        return await creditStep(address, txHash, amount)
      }
      const low = v.value - v.maxFee
      const inRange = (amount: string | null) => {
        const units = amount ? toUnits(amount, USDC_DECIMALS) : null
        return units !== null && units >= low && units <= v.value
      }
      // Attestation of this tx for a different amount: amount substitution, not "not arrived yet"
      const named = attestations.find((a) => attestationView(a.payload).hashes.includes(txHash))
      if (named && !inRange(attestationView(named.payload).amount))
        throw new ClaimError(
          'AMOUNT_MISMATCH',
          'The attested amount differs from the deposit on Ethereum',
        )
      const candidates = attestations
        .map((a) => ({ a, view: attestationView(a.payload) }))
        .filter(({ a, view }) => {
          if (used.has(a.contractId) || !view.amount) return false
          if (view.parties.length && !view.parties.includes(custody)) return false
          // The attestation names a tx: only that one; names another one: not ours
          if (view.hashes.length && !view.hashes.includes(txHash)) return false
          return inRange(view.amount)
        })
        .sort(
          (x, y) => Number(y.view.hashes.includes(txHash)) - Number(x.view.hashes.includes(txHash)),
        )
      const picked = candidates.find(({ a, view }) =>
        store.attachAttestation(txHash, a.contractId, dec(view.amount!).toFixed(10)),
      )
      if (!picked)
        throw new ClaimError(
          'NOT_ATTESTED',
          `xReserve has not attested ${fromUnits(v.value, USDC_DECIMALS)} USDC to Canton yet, try again later`,
        )
      const amount = picked.view.amount!
      const agreements = await ledger.query<{ user?: string }>(custody, {
        templateId: BRIDGE_TEMPLATES.userAgreement,
      })
      const agreement = agreements.find((a) => a.payload.user === custody) ?? agreements[0]
      if (!agreement)
        throw new ClaimError('NOT_ONBOARDED', 'The custody party is not onboarded to xReserve')
      const ctx = await deps.burnMint.context(deps.usdcx, [], [{ owner: deps.usdcx.admin, amount }])
      keep = true
      let updateId: string | null = null
      try {
        const r = await ledger.submit(
          [custody],
          [
            {
              ExerciseCommand: {
                templateId: BRIDGE_TEMPLATES.userAgreement,
                contractId: agreement.contractId,
                choice: 'BridgeUserAgreement_Mint',
                choiceArgument: {
                  depositAttestationCid: picked.a.contractId,
                  factoryCid: ctx.factoryCid,
                  contextContractIds: ctx.contextContractIds,
                },
              },
            },
          ],
          ctx.disclosed,
          [],
          { commandId: `xreserve-mint-${sha(txHash)}` },
        )
        updateId = r.updateId
      } catch (err) {
        const kind = classifyLedgerError(err)
        if (kind === 'transient') {
          // outcome unknown: the claim stays taken, a retry in a minute will cut off the duplicate
          throw new ClaimError('LEDGER_BUSY', 'The ledger is busy, try the claim again in a minute')
        }
        if (kind === 'rejected') {
          keep = false
          throw err
        }
        // duplicate: the same mint was already accepted
      }
      store.setClaimStatus(txHash, 'minted', updateId)
      count('minted')
      deps.log?.info({ event: 'xreserve_claim_minted', address, amount }, 'xReserve deposit minted')
      return await creditStep(address, txHash, amount)
    } catch (err) {
      if (!keep) store.abandonClaim(txHash)
      if (err instanceof ClaimError) count(err.code.toLowerCase())
      else count('error')
      throw err
    }
  }

  /**
   * Step 2: EvmWallet_CreditDeposit { instrumentId = USDCx, depositRef = txHash }. Custodian
   * holdings for the amount prove that the custodian has the USDCx (the contract does not spend
   * them); retries are cut off by DepositRegistry and commandId.
   */
  async function creditStep(address: string, txHash: string, amount: string): Promise<ClaimResult> {
    const done = () => {
      store.setClaimStatus(txHash, 'credited', store.claim(txHash)?.update_id ?? null)
      store.resolveQuarantine(`xreserve:${txHash}`, 'credited')
      count('credited')
      deps.log?.info(
        { event: 'xreserve_claim_credited', address, amount },
        'xReserve deposit credited',
      )
      return { txHash, amount: dec(amount).toFixed(), status: 'credited' as const }
    }
    try {
      await creditDeposit(
        {
          ledger,
          reader: deps.reader,
          ensureAccount: deps.ensureAccount,
          operator: deps.operator,
          custody,
        },
        {
          address,
          instrument: deps.usdcx,
          amount,
          depositRef: txHash,
          commandId: `xreserve-credit-${sha(txHash)}`,
        },
      )
    } catch (err) {
      if (err instanceof NoDepositRegistryError) throw new ClaimError('NOT_ONBOARDED', err.message)
      if (err instanceof CreditNotReadyError) throw new ClaimError('LEDGER_BUSY', err.message)
      const kind = classifyLedgerError(err)
      if (kind === 'rejected' && err instanceof LedgerError) {
        store.quarantine({
          id: `xreserve:${txHash}`,
          source: 'xreserve',
          cause: 'minted-not-credited',
          instrument: deps.usdcx,
          amount,
          sender: address,
          detail: err.publicText,
        })
        count('credit_rejected')
        deps.log?.error(
          { event: 'xreserve_credit_rejected', address, amount, err: err.publicText },
          'minted USDCx was not credited: quarantined',
        )
        throw err
      }
      throw new ClaimError('LEDGER_BUSY', 'The ledger is busy, try the claim again in a minute')
    }
    return done()
  }

  return { claim }
}

export type XreserveClaims = ReturnType<typeof createXreserveClaims>
