/**
 * Council commands (lending-governance 0.4.0, audit D-5, N4). The backend only builds the command:
 * council members and treasury sign with their own wallet; the backend has no council keys.
 * Exception: Proposal_ExecuteTrusted and council formation: their controller is the operator, the
 * operator runs them deliberately (scripts/governance.ts), not via the HTTP API.
 */
import type {
  CouncilRotationView,
  GovernanceProposalView,
  GovernanceView,
  IncomeProposalView,
} from '@lending/shared'
import type { Deployment } from '../deployment.ts'
import {
  type ActiveContract,
  type Command,
  type DisclosedContract,
  toDisclosed,
} from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import { CommandError, type PreparedCommand } from './commands.ts'
import { dec } from './math.ts'
import { proposalChanges } from './proposal-changes.ts'
import { type Reader, type Snapshot, trustedFactory } from './reader.ts'
import type { TokenRegistry } from './registry.ts'
import type {
  GovernanceCouncilPayload,
  IncomeProposalPayload,
  MarketParams,
  ParameterChangeProposalPayload,
  ProtocolParams,
  Roles,
} from './types.ts'

const EMPTY_EXTRA = { context: { values: {} }, meta: { values: {} } }

const sameRoles = (a: Roles, b: Roles) =>
  a.operator === b.operator &&
  a.oracle === b.oracle &&
  a.guardian === b.guardian &&
  a.treasury === b.treasury &&
  a.backstop === b.backstop &&
  a.liquidators.length === b.liquidators.length &&
  a.liquidators.every((l, i) => l === b.liquidators[i])

/**
 * The proposal requires the operator's signature (Proposal_ExecuteTrusted): role or factory change.
 */
export function needsTrusted(p: ParameterChangeProposalPayload, current: Roles): boolean {
  if (p.newRoles && !sameRoles(p.newRoles, current)) return true
  if (p.newTransferFactories) return true
  const change = p.featuredAppRightChange as { tag?: string } | null | undefined
  if (change && change.tag === 'FeaturedRight_Set') return true
  return false
}

/** Risk 9: a lower liquidateCollateralFactor waits this long after the proposal (Governance.daml). */
export const LIQUIDATION_FACTOR_DELAY_MS = 2 * 24 * 60 * 60 * 1000

/** Some market's liquidateCollateralFactor or liquidationFactor goes down (Governance.daml 1.0.2). */
export function lowersLiquidationFactor(
  current: [string, MarketParams][],
  next: [string, MarketParams][],
): boolean {
  const byId = new Map(next)
  return current.some(([id, m]) => {
    const n = byId.get(id)
    return (
      n !== undefined &&
      (dec(n.liquidateCollateralFactor).lt(m.liquidateCollateralFactor) ||
        dec(n.liquidationFactor).lt(m.liquidationFactor))
    )
  })
}

/** When a proposal that lowers a liquidation factor can execute; null when it can at once. */
export function executableAfter(
  p: Pick<ParameterChangeProposalPayload, 'newMarketParams' | 'proposedAt'>,
  config: { marketParams: [string, MarketParams][] },
): string | null {
  if (!p.proposedAt || !lowersLiquidationFactor(config.marketParams, p.newMarketParams)) return null
  return new Date(new Date(p.proposedAt).getTime() + LIQUIDATION_FACTOR_DELAY_MS).toISOString()
}

/**
 * A proposal's protocol parameters: top-level decimals and `rateModel.<field>` (the rate model and
 * the utilization ceiling, review 03.10 item 16). An unknown name is refused; the contract validates
 * the result (validateProtocolParams).
 */
export function applyParamsPatch(
  params: ProtocolParams,
  patch: Record<string, string>,
): ProtocolParams {
  const out = structuredClone(params) as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    const [head, field, ...rest] = k.split('.')
    const record = field === undefined ? out : out[head!]
    const key = field ?? head!
    if (
      rest.length > 0 ||
      (field !== undefined && head !== 'rateModel') ||
      typeof record !== 'object' ||
      record === null ||
      typeof (record as Record<string, unknown>)[key] !== 'string'
    )
      throw new CommandError(`Unknown protocol parameter ${k}`)
    ;(record as Record<string, unknown>)[key] = v
  }
  return out as unknown as ProtocolParams
}

export interface ProposeParamsInput {
  proposalId: string
  description: string
  expiresAt: Date
  newParams?: ProtocolParams
  newMarketParams?: [string, MarketParams][]
  newRoles?: Roles
}

export interface ProposeRotationInput {
  rotationId: string
  newMembers: string[]
  newThreshold: number
  expiresAt: Date
}

export interface ProposeIncomeInput {
  proposalId: string
  reservesAmount: string
  expiresAt: Date
}

export function createGovernance(d: Deployment, reader: Reader, registry: TokenRegistry) {
  const prepared = (
    actor: string,
    commands: Command[],
    disclosed: ActiveContract[],
  ): PreparedCommand => ({
    actAs: [actor],
    commands,
    disclosedContracts: [...new Map(disclosed.map((c) => [c.contractId, toDisclosed(c)])).values()],
  })
  const exercise = (
    templateId: string,
    contractId: string,
    choice: string,
    choiceArgument: Record<string, unknown>,
  ): Command => ({ ExerciseCommand: { templateId, contractId, choice, choiceArgument } })

  /** The operator's current council: the one that governs the config. */
  async function council(s?: Snapshot): Promise<ActiveContract<GovernanceCouncilPayload>> {
    const snap = s ?? (await reader.snapshot())
    const governors = snap.config.payload.governors
    const found = (await reader.councils()).find(
      (c) =>
        c.payload.operator === d.operator &&
        c.payload.members.length === governors.length &&
        c.payload.members.every((m) => governors.includes(m)),
    )
    if (!found) throw new CommandError('No governance council controls the protocol')
    return found
  }

  const asMember = (c: { members: string[] }, actor: string) => {
    if (!c.members.includes(actor)) throw new CommandError('Only a council member can do this')
  }

  async function byCid<T>(
    list: () => Promise<ActiveContract<T>[]>,
    cid: string,
    what: string,
  ): Promise<ActiveContract<T>> {
    const found = (await list()).find((c) => c.contractId === cid)
    if (!found) throw new CommandError(`${what} not found or already executed`)
    return found
  }

  /** Operator holdings for the amount, largest first: payout to treasury (Pool_WithdrawReserves). */
  async function operatorPayout(
    s: Snapshot,
    instrument: Deployment['usdcx'],
    amount: string,
    receiver: string,
  ) {
    const factoryCid = trustedFactory(s, instrument)
    if (dec(amount).lte(0))
      return {
        args: {
          factoryCid,
          inputHoldingCids: [],
          transferExtraArgs: EMPTY_EXTRA,
          acceptExtraArgs: EMPTY_EXTRA,
        },
        disclosed: [] as ActiveContract[],
        disclosedFactory: [] as DisclosedContract[],
      }
    const holdings = await reader.holdings(d.operator, instrument)
    const picked = []
    let covered = dec(0)
    for (const h of holdings) {
      if (covered.gte(amount)) break
      picked.push(h)
      covered = covered.plus(h.view.amount)
    }
    if (covered.lt(amount))
      throw new CommandError(`Protocol holds less ${instrument.id} than ${amount}`)
    const inputs = picked.map((h) => h.contract.contractId)
    const factory = await registry.transferFactory(instrument, factoryCid, {
      sender: d.operator,
      receiver,
      amount,
      inputHoldingCids: inputs,
    })
    return {
      args: {
        factoryCid: factory.factoryCid,
        inputHoldingCids: inputs,
        transferExtraArgs: factory.transferExtraArgs,
        acceptExtraArgs: factory.acceptExtraArgs,
      },
      disclosed: picked.map((h) => h.contract),
      disclosedFactory: factory.disclosed,
    }
  }

  return {
    async view(): Promise<GovernanceView> {
      const s = await reader.snapshot()
      const roles = s.config.payload.roles
      const [councils, proposals, rotations, income] = await Promise.all([
        reader.councils(),
        reader.proposals(),
        reader.rotations(),
        reader.incomeProposals(),
      ])
      const governors = s.config.payload.governors
      const current = councils.find(
        (c) =>
          c.payload.members.length === governors.length &&
          c.payload.members.every((m) => governors.includes(m)),
      )
      // A council of one party may be a BitSafe Decentralized Party (review 03.10, item 25)
      const decman = governors.length === 1 ? await reader.decman(governors[0]!) : null
      return {
        council: current
          ? {
              contractId: current.contractId,
              members: current.payload.members,
              threshold: Number(current.payload.threshold),
            }
          : null,
        decman,
        roles,
        proposals: proposals.map((p): GovernanceProposalView => ({
          contractId: p.contractId,
          proposalId: p.payload.proposalId,
          description: p.payload.description,
          proposer: p.payload.proposer,
          expiresAt: p.payload.expiresAt,
          executableAfter: executableAfter(p.payload, s.config.payload),
          approvals: p.payload.approvals,
          threshold: Number(p.payload.threshold),
          trusted: needsTrusted(p.payload, roles),
          newRoles: p.payload.newRoles ?? null,
          changes: proposalChanges(p.payload, s.config.payload),
        })),
        rotations: rotations.map((r): CouncilRotationView => ({
          contractId: r.contractId,
          rotationId: r.payload.rotationId,
          proposer: r.payload.proposer,
          members: r.payload.members,
          newMembers: r.payload.newMembers,
          newThreshold: Number(r.payload.newThreshold),
          threshold: Number(r.payload.threshold),
          expiresAt: r.payload.expiresAt,
          approvals: r.payload.approvals,
          joined: r.payload.joined,
          formation: r.payload.members.length === 0,
        })),
        income: income.map((i): IncomeProposalView => ({
          contractId: i.contractId,
          proposalId: i.payload.proposalId,
          proposer: i.payload.proposer,
          treasury: i.payload.treasury,
          reservesAmount: dec(i.payload.reservesAmount).toFixed(10),
          expiresAt: i.payload.expiresAt,
          approvals: i.payload.approvals,
          threshold: Number(i.payload.threshold),
        })),
      }
    },

    /**
     * Council_Propose: parameters, markets and roles (D-5). Anything not given is taken from the
     * current config: the proposal changes only what was passed. Roles are changed only by
     * Proposal_ExecuteTrusted, which needs the operator's signature.
     */
    async proposeParams(actor: string, input: ProposeParamsInput): Promise<PreparedCommand> {
      const s = await reader.snapshot()
      const c = await council(s)
      asMember(c.payload, actor)
      const cfg = s.config.payload
      if (input.newRoles && input.newRoles.operator !== cfg.roles.operator)
        throw new CommandError('The operator cannot change')
      if (input.expiresAt.getTime() <= Date.now())
        throw new CommandError('The proposal must expire in the future')
      if (
        input.newMarketParams &&
        lowersLiquidationFactor(cfg.marketParams, input.newMarketParams) &&
        input.expiresAt.getTime() <= Date.now() + LIQUIDATION_FACTOR_DELAY_MS
      )
        throw new CommandError(
          'A lower liquidation factor takes effect after 2 days: the proposal must expire later',
        )
      return prepared(
        actor,
        [
          exercise(TEMPLATES.governanceCouncil, c.contractId, 'Council_Propose', {
            proposer: actor,
            proposalId: input.proposalId,
            description: input.description,
            configCid: s.config.contractId,
            newParams: input.newParams ?? cfg.params,
            newMarketParams: input.newMarketParams ?? cfg.marketParams,
            newTransferFactories: null,
            expiresAt: input.expiresAt.toISOString(),
            featuredAppRightChange: null,
            newRoles: input.newRoles ?? null,
          }),
        ],
        [s.config],
      )
    },

    async approveProposal(actor: string, cid: string): Promise<PreparedCommand> {
      const p = await byCid(reader.proposals, cid, 'Proposal')
      asMember(p.payload, actor)
      if (p.payload.approvals.includes(actor)) throw new CommandError('Already approved')
      return prepared(
        actor,
        [
          exercise(TEMPLATES.parameterChangeProposal, cid, 'Proposal_Approve', {
            approver: actor,
          }),
        ],
        [],
      )
    },

    /** Proposal_Execute by threshold: no role or factory change (otherwise the trusted path). */
    async executeProposal(actor: string, cid: string): Promise<PreparedCommand> {
      const s = await reader.snapshot()
      const p = await byCid(reader.proposals, cid, 'Proposal')
      asMember(p.payload, actor)
      if (needsTrusted(p.payload, s.config.payload.roles))
        throw new CommandError(
          'This proposal changes roles or factories: the operator executes it (Proposal_ExecuteTrusted)',
        )
      if (p.payload.approvals.length < Number(p.payload.threshold))
        throw new CommandError('Not enough approvals')
      const after = executableAfter(p.payload, s.config.payload)
      if (after && new Date(after).getTime() > Date.now())
        throw new CommandError(`A lower liquidation factor executes from ${after}`)
      return prepared(
        actor,
        [
          exercise(TEMPLATES.parameterChangeProposal, cid, 'Proposal_Execute', {
            executor: actor,
            configCid: s.config.contractId,
          }),
        ],
        [s.config],
      )
    },

    /**
     * Proposal_ExecuteTrusted (D-5): the controller is the operator, the approval threshold is
     * required. Only for the operator script: not exposed over HTTP.
     */
    async executeTrusted(proposalId: string): Promise<PreparedCommand> {
      const s = await reader.snapshot()
      const p = (await reader.proposals()).find((x) => x.payload.proposalId === proposalId)
      if (!p) throw new CommandError(`Proposal ${proposalId} not found`)
      if (p.payload.approvals.length < Number(p.payload.threshold))
        throw new CommandError(
          `Proposal ${proposalId} has ${p.payload.approvals.length} of ${p.payload.threshold} approvals`,
        )
      return prepared(
        d.operator,
        [
          exercise(TEMPLATES.parameterChangeProposal, p.contractId, 'Proposal_ExecuteTrusted', {
            configCid: s.config.contractId,
            // 1.0.4: a new guardian gets the pause flags in the same transaction (review item 14)
            pauseCid: s.pause.contractId,
          }),
        ],
        [],
      )
    },

    async withdrawProposal(actor: string, cid: string): Promise<PreparedCommand> {
      const p = await byCid(reader.proposals, cid, 'Proposal')
      if (p.payload.proposer !== actor) throw new CommandError('Only the proposer can withdraw')
      return prepared(
        actor,
        [exercise(TEMPLATES.parameterChangeProposal, cid, 'Proposal_Withdraw', { actor })],
        [],
      )
    },

    // Council rotation --------------------------------------------------------------

    async proposeRotation(actor: string, input: ProposeRotationInput): Promise<PreparedCommand> {
      const c = await council()
      asMember(c.payload, actor)
      const unique = new Set(input.newMembers)
      if (unique.size !== input.newMembers.length) throw new CommandError('Members must differ')
      if (input.newMembers.includes(d.operator))
        throw new CommandError('The operator cannot be a council member')
      if (input.newThreshold < 1 || input.newThreshold > input.newMembers.length)
        throw new CommandError('Threshold must be between 1 and the number of members')
      if (input.expiresAt.getTime() <= Date.now())
        throw new CommandError('The rotation must expire in the future')
      return prepared(
        actor,
        [
          exercise(TEMPLATES.governanceCouncil, c.contractId, 'Council_ProposeRotation', {
            proposer: actor,
            rotationId: input.rotationId,
            newMembers: input.newMembers,
            newThreshold: String(input.newThreshold),
            expiresAt: input.expiresAt.toISOString(),
          }),
        ],
        [],
      )
    },

    async approveRotation(actor: string, cid: string): Promise<PreparedCommand> {
      const r = await byCid(reader.rotations, cid, 'Rotation')
      asMember(r.payload, actor)
      if (r.payload.approvals.includes(actor)) throw new CommandError('Already approved')
      return prepared(
        actor,
        [exercise(TEMPLATES.councilRotation, cid, 'Rotation_Approve', { approver: actor })],
        [],
      )
    },

    /**
     * The new member signs the rotation with their key (observer of the rotation: no disclosure
     * needed).
     */
    async joinRotation(actor: string, cid: string): Promise<PreparedCommand> {
      const r = await byCid(reader.rotations, cid, 'Rotation')
      if (!r.payload.newMembers.includes(actor) || r.payload.members.includes(actor))
        throw new CommandError('Only a new council member joins a rotation')
      if (r.payload.joined.includes(actor)) throw new CommandError('Already joined')
      return prepared(
        actor,
        [exercise(TEMPLATES.councilRotation, cid, 'Rotation_Join', { joiner: actor })],
        [],
      )
    },

    /**
     * Rotation_Execute by a member of the current council: the pool is not visible to members, so
     * it and the config are disclosed. `executor`: a council member, or the operator (formation,
     * operator script).
     */
    async executeRotation(executor: string, cid: string): Promise<PreparedCommand> {
      const s = await reader.snapshot()
      const r = await byCid(reader.rotations, cid, 'Rotation')
      const formation = r.payload.members.length === 0
      if (executor !== d.operator) asMember(r.payload, executor)
      if (r.payload.approvals.length < Number(r.payload.threshold))
        throw new CommandError('Not enough approvals')
      const missing = r.payload.newMembers.filter(
        (m) => !r.payload.members.includes(m) && !r.payload.joined.includes(m),
      )
      if (missing.length) throw new CommandError(`${missing.length} new member(s) have not joined`)
      const councilCid = formation ? null : (await council(s)).contractId
      return prepared(
        executor,
        [
          exercise(TEMPLATES.councilRotation, cid, 'Rotation_Execute', {
            executor,
            councilCid,
            configCid: s.config.contractId,
            poolCid: s.pool.contractId,
          }),
        ],
        [s.config, s.pool],
      )
    },

    async withdrawRotation(actor: string, cid: string): Promise<PreparedCommand> {
      const r = await byCid(reader.rotations, cid, 'Rotation')
      if (r.payload.proposer !== actor) throw new CommandError('Only the proposer can withdraw')
      return prepared(
        actor,
        [exercise(TEMPLATES.councilRotation, cid, 'Rotation_Withdraw', { actor })],
        [],
      )
    },

    // Reserves to treasury (N4, K6) ---------------------------------------------------------

    async proposeIncome(actor: string, input: ProposeIncomeInput): Promise<PreparedCommand> {
      const s = await reader.snapshot()
      const c = await council(s)
      asMember(c.payload, actor)
      if (!dec(input.reservesAmount).gt(0)) throw new CommandError('The amount must be positive')
      if (input.expiresAt.getTime() <= Date.now())
        throw new CommandError('The proposal must expire in the future')
      return prepared(
        actor,
        [
          exercise(TEMPLATES.governanceCouncil, c.contractId, 'Council_ProposeIncome', {
            proposer: actor,
            proposalId: input.proposalId,
            treasury: s.config.payload.roles.treasury,
            reservesAmount: input.reservesAmount,
            expiresAt: input.expiresAt.toISOString(),
          }),
        ],
        [],
      )
    },

    async approveIncome(actor: string, cid: string): Promise<PreparedCommand> {
      const p = await byCid(reader.incomeProposals, cid, 'Income proposal')
      asMember(p.payload, actor)
      if (p.payload.approvals.includes(actor)) throw new CommandError('Already approved')
      return prepared(
        actor,
        [exercise(TEMPLATES.incomeProposal, cid, 'IncomeProposal_Approve', { approver: actor })],
        [],
      )
    },

    /**
     * Treasury submits IncomeProposal_Execute with its own wallet: the pool, config and operator
     * holdings are not visible to it; they go in disclosure, as in user commands.
     */
    async executeIncome(treasury: string, cid: string): Promise<PreparedCommand> {
      const s = await reader.snapshot()
      const p = await byCid<IncomeProposalPayload>(reader.incomeProposals, cid, 'Income proposal')
      if (p.payload.treasury !== treasury || s.config.payload.roles.treasury !== treasury)
        throw new CommandError('Only the treasury executes income proposals')
      if (p.payload.approvals.length < Number(p.payload.threshold))
        throw new CommandError('Not enough approvals')
      const reserves = await operatorPayout(
        s,
        d.usdcx,
        dec(p.payload.reservesAmount).toFixed(10),
        treasury,
      )
      const disclosed: ActiveContract[] = [s.config, s.pool, ...reserves.disclosed]
      const cmd = prepared(
        treasury,
        [
          exercise(TEMPLATES.incomeProposal, cid, 'IncomeProposal_Execute', {
            poolCid: s.pool.contractId,
            configCid: s.config.contractId,
            reservesPayout: reserves.args,
          }),
        ],
        disclosed,
      )
      // Registry factory contexts (already in DisclosedContract form)
      return {
        ...cmd,
        disclosedContracts: [
          ...new Map(
            [...cmd.disclosedContracts, ...reserves.disclosedFactory].map((c) => [c.contractId, c]),
          ).values(),
        ],
      }
    },

    async withdrawIncome(actor: string, cid: string): Promise<PreparedCommand> {
      const p = await byCid(reader.incomeProposals, cid, 'Income proposal')
      if (p.payload.proposer !== actor) throw new CommandError('Only the proposer can withdraw')
      return prepared(
        actor,
        [exercise(TEMPLATES.incomeProposal, cid, 'IncomeProposal_Withdraw', { actor })],
        [],
      )
    },
  }
}

export type Governance = ReturnType<typeof createGovernance>
