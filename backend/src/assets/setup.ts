/**
 * Custodian setup for real assets (seam 2), idempotent. Run via scripts/
 * assets-setup.ts (`pnpm --filter @lending/backend assets:setup-cc|xreserve|registry`).
 *
 * - cc: CC TransferPreapproval for the custodian (TransferPreapprovalProposal, provider is
 *   CC_PREAPPROVAL_PROVIDER, usually the validator operator: it pays the fee and renews).
 *   With a preapproval CC transfers are direct, without a TransferInstruction: the deposits bot
 *   reads the memo from the transfer transaction and credits via EvmWallet_CreditDeposit
 *   (DepositRegistry required).
 * - xreserve: the custodian's BridgeUserAgreementRequest (onboarding to the DA Utilities bridge);
 *   who approves it and how is unpublished (research §2 [?]), the script waits for a
 *   BridgeUserAgreement.
 * - registry: DepositRegistry (lending-core 0.6.0), the registry of credited deposits for
 *   EvmWallet_CreditDeposit (xReserve, CC via preapproval, withdrawal refunds); signed by
 *   operator and custodian in one command. Created by cc, by xreserve, and by its own command.
 */
import type { LedgerClient } from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import { sha } from '../protocol/evm.ts'
import { BRIDGE_TEMPLATES, PREAPPROVAL_TEMPLATES, type RealProfile } from './profiles.ts'

export type SetupOutcome =
  | { state: 'exists'; contractId: string }
  | { state: 'requested'; contractId: string | null }
  | { state: 'pending'; contractId: string }

export async function setupCcPreapproval(
  ledger: LedgerClient,
  profile: RealProfile,
  custody: string,
  provider: string | undefined,
): Promise<SetupOutcome> {
  const existing = await ledger.query<{ receiver?: string }>(custody, {
    templateId: PREAPPROVAL_TEMPLATES.preapproval,
  })
  const mine = existing.find((c) => c.payload.receiver === custody)
  if (mine) return { state: 'exists', contractId: mine.contractId }
  const proposals = await ledger.query<{ receiver?: string }>(custody, {
    templateId: PREAPPROVAL_TEMPLATES.proposal,
  })
  const pending = proposals.find((c) => c.payload.receiver === custody)
  if (pending) return { state: 'pending', contractId: pending.contractId }
  if (!provider?.includes('::'))
    throw new Error('set CC_PREAPPROVAL_PROVIDER: the party that pays and renews the preapproval')
  const r = await ledger.submit(
    [custody],
    [
      {
        CreateCommand: {
          templateId: PREAPPROVAL_TEMPLATES.proposal,
          createArguments: {
            receiver: custody,
            provider,
            expectedDso: profile.instruments.cc.admin,
          },
        },
      },
    ],
    [],
    [],
    { commandId: `cc-preapproval-${sha(custody)}` },
  )
  const created = r.events.find((e) =>
    e.CreatedEvent?.templateId.endsWith(':TransferPreapprovalProposal'),
  )
  return { state: 'requested', contractId: created?.CreatedEvent?.contractId ?? null }
}

export async function setupXreserveOnboarding(
  ledger: LedgerClient,
  profile: RealProfile,
  custody: string,
): Promise<SetupOutcome> {
  const agreements = await ledger.query<{ user?: string }>(custody, {
    templateId: BRIDGE_TEMPLATES.userAgreement,
  })
  const mine = agreements.find((c) => c.payload.user === custody)
  if (mine) return { state: 'exists', contractId: mine.contractId }
  const requests = await ledger.query<{ user?: string }>(custody, {
    templateId: BRIDGE_TEMPLATES.userAgreementRequest,
  })
  const pending = requests.find((c) => c.payload.user === custody)
  if (pending) return { state: 'pending', contractId: pending.contractId }
  const usdcx = profile.instruments.usdcx
  const r = await ledger.submit(
    [custody],
    [
      {
        CreateCommand: {
          templateId: BRIDGE_TEMPLATES.userAgreementRequest,
          createArguments: {
            crossChainRepresentative: usdcx.admin,
            operator: profile.bridge.utilityOperator,
            bridgeOperator: profile.bridge.bridgeOperator,
            user: custody,
            instrumentId: { admin: usdcx.admin, id: usdcx.id },
            preApproval: false,
          },
        },
      },
    ],
    [],
    [],
    { commandId: `xreserve-onboard-${sha(custody)}` },
  )
  const created = r.events.find((e) =>
    e.CreatedEvent?.templateId.endsWith(':BridgeUserAgreementRequest'),
  )
  return { state: 'requested', contractId: created?.CreatedEvent?.contractId ?? null }
}

/**
 * DepositRegistry of operator and custodian (0.6.0). A command from both parties: requires a
 * credential with CanActAs operator and custody (as for deployProd); separate role credentials will
 * not do.
 */
export async function setupDepositRegistry(
  ledger: LedgerClient,
  operator: string,
  custody: string,
): Promise<SetupOutcome> {
  const existing = await ledger.query<{ operator?: string; custody?: string }>(custody, {
    templateId: TEMPLATES.depositRegistry,
  })
  const mine = existing.find(
    (c) => c.payload.operator === operator && c.payload.custody === custody,
  )
  if (mine) return { state: 'exists', contractId: mine.contractId }
  const r = await ledger.submit(
    [operator, custody],
    [
      {
        CreateCommand: {
          templateId: TEMPLATES.depositRegistry,
          createArguments: { operator, custody, refs: { map: [] } },
        },
      },
    ],
    [],
    [],
    { commandId: `deposit-registry-${sha(custody)}` },
  )
  const created = r.events.find((e) => e.CreatedEvent?.templateId.endsWith(':DepositRegistry'))
  return { state: 'requested', contractId: created?.CreatedEvent?.contractId ?? null }
}
