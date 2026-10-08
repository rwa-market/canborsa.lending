/**
 * redeems bot (ASSET_PROFILE=real only, seam 2). RedeemRequest (lending-core 0.6.0) is
 * a signed request to withdraw USDCx to Ethereum; the wallet balance is already debited, the
 * holdings are with the custodian. The bot burns them in xReserve and closes the request:
 *
 *   BridgeUserAgreement_Burn (custodian; reference = requestId)
 *     success → RedeemRequest_Complete { burnReference = updateId burn }
 *     rejection → RedeemRequest_Refund { actor = custody, reason }: the amount returns to the
 *     wallet
 *
 * Idempotent by requestId: the step goes into redeem_state before submitting, commandId from
 * requestId. If the process crashed after submitting the burn, the ledger cuts off a retry with the
 * same commandId as a duplicate. A rejected retry after an unknown outcome does not return the
 * money (the burn may have gone through): stuck, a metric and manual investigation.
 */
import type { FastifyBaseLogger } from 'fastify'
import {
  BRIDGE_TEMPLATES,
  ETHEREUM_DOMAIN,
  type RealProfile,
  sameInstrument,
} from '../assets/profiles.ts'
import type { RealAssetsStore } from '../assets/store.ts'
import type { BurnMintFactory } from '../assets/utilities.ts'
import type { Deployment, Instrument } from '../deployment.ts'
import {
  type ActiveContract,
  classifyLedgerError,
  LedgerError,
  type LedgerClient,
} from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import type { Metrics } from '../metrics.ts'
import { CommandError, selectInputs } from '../protocol/commands.ts'
import { dec } from '../protocol/math.ts'
import type { Reader } from '../protocol/reader.ts'

export interface RedeemRequestPayload {
  operator: string
  custody: string
  address: string
  instrumentId?: Instrument
  amount: string
  ethAddress: string
  requestId: string
  createdAt?: string
}

export function createRedeemsBot(deps: {
  ledger: LedgerClient
  reader: Reader
  store: RealAssetsStore
  burnMint: BurnMintFactory
  deployment: Deployment
  profile: RealProfile
  log: FastifyBaseLogger
  metrics?: Metrics
}) {
  const { ledger, store, profile } = deps
  const custody = deps.deployment.evm?.custody
  if (!custody) throw new Error('BOTS=redeems needs deployment.json evm.custody')
  const usdcx = profile.instruments.usdcx
  const outcome = (o: string): void =>
    deps.metrics?.inc('redeems_total', 'USDCx redemptions to Ethereum by outcome', { outcome: o })

  const exercise = (
    templateId: string,
    contractId: string,
    choice: string,
    choiceArgument: unknown,
  ) => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } })

  async function complete(r: ActiveContract<RedeemRequestPayload>, burnReference: string) {
    await ledger.submit(
      [custody!],
      [
        exercise(TEMPLATES.redeemRequest, r.contractId, 'RedeemRequest_Complete', {
          burnReference,
        }),
      ],
      [],
      [],
      { commandId: `redeem-complete-${r.payload.requestId}` },
    )
    store.setRedeem(r.payload.requestId, r.contractId, 'completed', { burnReference })
    outcome('completed')
    deps.log.info(
      { event: 'redeem_completed', requestId: r.payload.requestId, amount: r.payload.amount },
      'USDCx redeemed to Ethereum',
    )
  }

  async function refund(r: ActiveContract<RedeemRequestPayload>, reason: string) {
    const wallet = await deps.reader.evmWallet(r.payload.address)
    if (!wallet) throw new Error(`redeem ${r.payload.requestId}: no EVM wallet to refund`)
    await ledger.submit(
      [custody!],
      [
        exercise(TEMPLATES.redeemRequest, r.contractId, 'RedeemRequest_Refund', {
          actor: custody,
          walletCid: wallet.contractId,
          reason: reason.slice(0, 200) || 'redeem failed',
        }),
      ],
      [],
      [],
      { commandId: `redeem-refund-${r.payload.requestId}` },
    )
    store.setRedeem(r.payload.requestId, r.contractId, 'refunded', { reason })
    outcome('refunded')
    deps.log.warn(
      { event: 'redeem_refunded', requestId: r.payload.requestId, reason },
      'USDCx redemption refunded to the EVM wallet',
    )
  }

  /** A request that cannot be burned by construction: amount, address, instrument. */
  function invalid(p: RedeemRequestPayload): string | null {
    if (p.instrumentId && !sameInstrument(p.instrumentId, usdcx)) return 'not USDCx'
    if (!/^\d+(\.\d{1,6})?$/.test(dec(p.amount).toFixed()) || !dec(p.amount).gt(0))
      return 'amount must be positive with at most 6 decimals'
    if (!/^0x[0-9a-f]{40}$/.test(p.ethAddress)) return 'malformed Ethereum address'
    return null
  }

  async function burn(r: ActiveContract<RedeemRequestPayload>, retry: boolean) {
    const p = r.payload
    const agreements = await ledger.query<{ user?: string }>(custody!, {
      templateId: BRIDGE_TEMPLATES.userAgreement,
    })
    const agreement = agreements.find((a) => a.payload.user === custody) ?? agreements[0]
    // No onboarding is a setup error, not a request rejection: the bot step fails, alert
    if (!agreement)
      throw new Error('custody party is not onboarded to xReserve (assets:setup-xreserve)')
    const amount = dec(p.amount).toFixed()
    let inputs: string[]
    let covered = dec(0)
    try {
      const held = await deps.reader.holdings(custody!, usdcx)
      inputs = selectInputs(held, amount)
      for (const h of held)
        if (inputs.includes(h.contract.contractId)) covered = covered.plus(h.view.amount)
    } catch (err) {
      if (err instanceof CommandError && !retry)
        return refund(r, `custody holdings: ${err.message}`)
      throw err
    }
    const change = covered.minus(amount)
    const ctx = await deps.burnMint.context(
      usdcx,
      inputs,
      change.gt(0) ? [{ owner: custody!, amount: change.toFixed() }] : [],
    )
    store.setRedeem(p.requestId, r.contractId, 'burning')
    let burnReference: string
    try {
      const res = await ledger.submit(
        [custody!],
        [
          exercise(
            BRIDGE_TEMPLATES.userAgreement,
            agreement.contractId,
            'BridgeUserAgreement_Burn',
            {
              amount,
              destinationDomain: ETHEREUM_DOMAIN,
              destinationRecipient: p.ethAddress,
              holdingCids: inputs,
              requestId: p.requestId,
              reference: p.requestId,
              factoryCid: ctx.factoryCid,
              contextContractIds: ctx.contextContractIds,
            },
          ),
        ],
        ctx.disclosed,
        [],
        { commandId: `xreserve-burn-${p.requestId}` },
      )
      burnReference = res.updateId
    } catch (err) {
      const kind = classifyLedgerError(err)
      if (kind === 'duplicate') burnReference = `request:${p.requestId}`
      else if (kind === 'rejected' && err instanceof LedgerError && !retry) {
        return refund(r, err.publicText)
      } else if (kind === 'rejected' && retry) {
        // outcome of the previous submit is unknown: do not return the money blindly
        store.setRedeem(p.requestId, r.contractId, 'stuck', { reason: String(err).slice(0, 300) })
        outcome('stuck')
        deps.log.error(
          { event: 'redeem_stuck', requestId: p.requestId },
          'redeem burn retry was rejected after an unknown outcome: check xReserve by requestId',
        )
        return
      } else throw err
    }
    store.setRedeem(p.requestId, r.contractId, 'burned', { burnReference })
    outcome('burned')
    await complete(r, burnReference)
  }

  return async function step() {
    const requests = await ledger.query<RedeemRequestPayload>(custody!, {
      templateId: TEMPLATES.redeemRequest,
    })
    let open = 0
    let failed: unknown = null
    for (const r of requests) {
      const p = r.payload
      if (p.custody !== custody || p.operator !== deps.deployment.operator) continue
      open++
      const st = store.redeem(p.requestId)
      if (st?.status === 'stuck') continue
      try {
        if (st?.status === 'burned' || st?.status === 'completed') {
          await complete(r, st.burn_reference ?? `request:${p.requestId}`)
          continue
        }
        if (st?.status === 'refunded') {
          await refund(r, 'retry')
          continue
        }
        const why = invalid(p)
        if (why) {
          await refund(r, why)
          continue
        }
        await burn(r, st?.status === 'burning')
      } catch (err) {
        failed = err
        deps.metrics?.inc('redeems_retry_total', 'Redeem steps to retry', {})
        deps.log.warn(
          { event: 'redeem_retry', requestId: p.requestId, err: String(err) },
          'redeem step failed, will retry',
        )
      }
    }
    deps.metrics?.gauge('redeems_open', 'Open RedeemRequest contracts', open)
    // A failed step shows in /health/ready and bot_failures (B-10); the other requests already went
    // through
    if (failed) throw failed
  }
}
