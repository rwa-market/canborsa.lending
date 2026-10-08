/**
 * Building user commands for the wallet (T3.1.2). The backend returns the command and disclosed
 * contracts, the user's wallet signs it (dApp SDK prepareExecute). The contract does the checks.
 */
import type { PreparedCommand as SealedCommand } from '@lending/shared'
import type { Deployment, Instrument, MarketId } from '../deployment.ts'
import { type Command, type DisclosedContract, toDisclosed } from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import { accrue, dec, presentValue } from './math.ts'
import { ProtocolStateError } from './errors.ts'
import { ALL_HORIZON_MS } from './preview.ts'
import { accountView, poolNumbers, quoteCollateral, saleView } from './views.ts'
import {
  attestationFor,
  byAmountDesc,
  collateralInstrument,
  collateralOf,
  feedFor,
  type Reader,
  type Snapshot,
  trustedFactory,
} from './reader.ts'
import type { TokenRegistry } from './registry.ts'
import { PAUSE_FLAG_CONSTRUCTORS, type PauseFlagName } from '@lending/shared'
import type { AccountPayload } from './types.ts'
import type { ActiveContract } from '../ledger/client.ts'

/** Wallet command before the server seal: the shared type from shared without `seal` (A-7). */
export type PreparedCommand = Omit<SealedCommand, 'seal' | 'commands' | 'disclosedContracts'> & {
  commands: Command[]
  disclosedContracts: DisclosedContract[]
}

/** Cap on the Login expiry the backend sets itself (agreement §2): at most 10 minutes. */
export const LOGIN_MAX_TTL_MS = 10 * 60_000

export class CommandError extends Error {}

interface TransferArgs {
  factoryCid: string
  inputHoldingCids: string[]
  transferExtraArgs: unknown
  acceptExtraArgs: unknown
}

/** Amount from the request: a decimal string or "max" ("withdraw all" / "repay all"). */
export type AmountInput = string

const MAX = 'max'

export { ALL_HORIZON_MS }

/**
 * F-16: no more inputs than this in one transfer: the factory and traffic hit the transaction
 * size limit. The user merges dust first (merge in the wallet).
 */
export const MAX_INPUT_HOLDINGS = 20

/** Transfer inputs: largest first until the amount is covered; at most `max`. */
export function selectInputs(
  holdings: { contract: { contractId: string }; view: { amount: string } }[],
  amount: string,
  max: number = MAX_INPUT_HOLDINGS,
): string[] {
  const sorted = [...holdings].sort(byAmountDesc)
  const want = dec(amount)
  const picked: string[] = []
  let covered = dec(0)
  for (const h of sorted) {
    if (covered.gte(want)) break
    if (picked.length >= max)
      throw new CommandError(
        `The amount needs more than ${max} holdings: merge small holdings in the wallet first`,
      )
    picked.push(h.contract.contractId)
    covered = covered.plus(h.view.amount)
  }
  if (covered.lt(want))
    throw new CommandError(`Wallet holds ${covered.toFixed(10, 1)}, less than ${amount}`)
  return picked
}

/**
 * Whose account and who pays. A Canton party is a string: both the account and the holdings are its
 * own. An EVM wallet account (0.5.0, ADR-004) is an address, while the custodian pays and receives.
 */
export type User = string | { key: string; party: string }
const keyOf = (u: User) => (typeof u === 'string' ? u : u.key)
const partyOf = (u: User) => (typeof u === 'string' ? u : u.party)

export function createCommandBuilder(d: Deployment, reader: Reader, registry: TokenRegistry) {
  /**
   * Transfer from the user: their holdings from the request or, if the backend sees them, from the
   * ledger.
   */
  async function userPayment(
    s: Snapshot,
    user: string,
    instrument: Instrument,
    inputHoldingCids?: string[],
    amount?: string,
  ) {
    // Wallet inputs (Loop) as the wallet sent them; for its own parties the backend picks them to
    // cover the amount (F-16)
    let inputs = inputHoldingCids ?? []
    if (!inputs.length) {
      const own = await reader.holdings(user, instrument)
      if (own.length === 0) throw new CommandError(`No ${instrument.id} in the wallet`)
      inputs =
        amount !== undefined
          ? selectInputs(own, amount)
          : own.slice(0, MAX_INPUT_HOLDINGS).map((h) => h.contract.contractId)
    }
    const factory = await registry.transferFactory(instrument, trustedFactory(s, instrument), {
      sender: user,
      receiver: d.operator,
      amount: amount ?? '0',
      inputHoldingCids: inputs,
    })
    const args: TransferArgs = {
      factoryCid: factory.factoryCid,
      inputHoldingCids: inputs,
      transferExtraArgs: factory.transferExtraArgs,
      acceptExtraArgs: factory.acceptExtraArgs,
    }
    return { args, disclosed: factory.disclosed }
  }

  /**
   * Payout from the operator: operator holdings for the amount, largest first, with disclosure. The
   * caller has already capped the amount at what the contract will accept (B-12): otherwise a
   * request for the whole pool would disclose all operator holdings.
   */
  async function operatorPayout(
    s: Snapshot,
    instrument: Instrument,
    amount: string,
    receiver: string,
  ) {
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
    const factory = await registry.transferFactory(instrument, trustedFactory(s, instrument), {
      sender: d.operator,
      receiver,
      amount,
      inputHoldingCids: picked.map((h) => h.contract.contractId),
    })
    const args: TransferArgs = {
      factoryCid: factory.factoryCid,
      inputHoldingCids: picked.map((h) => h.contract.contractId),
      transferExtraArgs: factory.transferExtraArgs,
      acceptExtraArgs: factory.acceptExtraArgs,
    }
    return {
      args,
      disclosed: [...factory.disclosed, ...picked.map((h) => toDisclosed(h.contract))],
    }
  }

  async function base(user: string) {
    const [snapshot, account] = await Promise.all([reader.snapshot(), reader.account(user)])
    if (!account) throw new CommandError('Open an account first')
    return { snapshot, account }
  }

  function poolExercise(
    s: Snapshot,
    choice: string,
    choiceArgument: Record<string, unknown>,
  ): Command {
    return {
      ExerciseCommand: {
        templateId: TEMPLATES.pool,
        contractId: s.pool.contractId,
        choice,
        choiceArgument: { configCid: s.config.contractId, ...choiceArgument },
      },
    }
  }

  /** The USDCx feed of the current oracle; none means feeds are not published or rotated (§4). */
  function debtFeedOf(s: Snapshot) {
    const debtFeed = feedFor(s, d.usdcx)
    if (!debtFeed) {
      const stale = s.feeds.some((f) => f.payload.oracle !== s.config.payload.roles.oracle)
      if (stale) throw new ProtocolStateError('PRICE_FEED_WRONG_ORACLE')
      throw new CommandError('Price feeds are not published')
    }
    return debtFeed
  }

  /**
   * PriceArgs of an account (K3): a feed for every collateral asset it holds, the USDCx feed and the
   * attestations the assets need. A missing collateral feed counts the asset as zero in the contract.
   */
  function priceArgs(s: Snapshot, account: AccountPayload) {
    const debtFeed = debtFeedOf(s)
    const assets = [...collateralOf(account).keys()]
    const collateralFeeds = assets
      .map((m) => feedFor(s, collateralInstrument(s, m)))
      .filter((f) => f !== undefined)
    const attestations = assets
      .filter((m) => s.marketParams.get(m)?.requiresReserveAttestation)
      .map((m) => attestationFor(s, collateralInstrument(s, m)))
      .filter((a) => a !== undefined)
    return {
      args: {
        collateralFeedCids: collateralFeeds.map((f) => f.contractId),
        debtFeedCid: debtFeed.contractId,
        attestationCids: attestations.map((a) => a.contractId),
      },
      disclosed: [debtFeed, ...collateralFeeds, ...attestations].map(toDisclosed),
    }
  }

  const noPrices = { collateralFeedCids: [], debtFeedCid: null, attestationCids: [] }

  const core = (s: Snapshot) => [
    toDisclosed(s.config),
    toDisclosed(s.pool),
    toDisclosed(s.pause),
    ...(s.featuredAppRight ? [toDisclosed(s.featuredAppRight)] : []),
  ]
  const dedupe = (xs: DisclosedContract[]) => [
    ...new Map(xs.map((x) => [x.contractId, x])).values(),
  ]
  const prepared = (
    user: string,
    commands: Command[],
    disclosed: DisclosedContract[],
  ): PreparedCommand => ({
    actAs: [user],
    commands,
    disclosedContracts: dedupe(disclosed),
  })

  /** Treasury commands: pays USDCx from its own holdings into the pool. */
  function asTreasury(s: Snapshot, actor: string) {
    if (actor !== s.config.payload.roles.treasury)
      throw new CommandError('Only the treasury can do this')
  }

  /** Signed balance of the account now and at the signing deadline (F-11). */
  function balances(s: Snapshot, account: ActiveContract<AccountPayload>) {
    const rm = s.config.payload.params.rateModel
    const principal = dec(account.payload.principal)
    return {
      now: presentValue(principal, accrue(rm, new Date(), s.pool.payload.state)),
      later: presentValue(
        principal,
        accrue(rm, new Date(Date.now() + ALL_HORIZON_MS), s.pool.payload.state),
      ),
    }
  }

  /**
   * Supply USDCx (Pool_SupplyBase): the debt is repaid first. all: repay the whole debt, the cap is
   * the debt at the signing deadline rounded up; the contract debits the exact debt as of the
   * transaction and the registry returns the change.
   */
  async function supplyBase(
    user: User,
    amount: AmountInput,
    all: boolean,
    inputHoldingCids?: string[],
  ): Promise<PreparedCommand> {
    const { snapshot: s, account } = await base(keyOf(user))
    let request = amount
    if (all || amount === MAX) {
      const debt = balances(s, account).later.neg()
      if (debt.lte(0)) throw new CommandError('No debt to repay')
      request = debt.toFixed(10, 0)
    }
    const full = all || amount === MAX
    const pay = await userPayment(s, partyOf(user), d.usdcx, inputHoldingCids, request)
    return prepared(
      partyOf(user),
      [
        poolExercise(s, 'Pool_SupplyBase', {
          user: partyOf(user),
          accountCid: account.contractId,
          amount: request,
          full,
          payment: pay.args,
        }),
      ],
      [...core(s), ...pay.disclosed],
    )
  }

  return {
    /**
     * Transfer from the EVM wallet custodian to a Canton party (EvmTransferOut, 0.6.0): custodian
     * holdings for the amount, trusted factory context; pool and config disclosure together.
     */
    async custodyTransfer(
      custody: string,
      instrument: Instrument,
      amount: string,
      receiver: string,
    ) {
      const s = await reader.snapshot()
      let factoryCid: string
      try {
        factoryCid = trustedFactory(s, instrument)
      } catch {
        throw new CommandError(`${instrument.id} has no trusted transfer factory`)
      }
      const own = await reader.holdings(custody, instrument)
      if (own.length === 0) throw new CommandError(`No ${instrument.id} is held for EVM wallets`)
      const inputs = selectInputs(own, amount)
      const factory = await registry.transferFactory(instrument, factoryCid, {
        sender: custody,
        receiver,
        amount,
        inputHoldingCids: inputs,
      })
      const args: TransferArgs = {
        factoryCid: factory.factoryCid,
        inputHoldingCids: inputs,
        transferExtraArgs: factory.transferExtraArgs,
        acceptExtraArgs: factory.acceptExtraArgs,
      }
      return { snapshot: s, args, disclosed: dedupe([...core(s), ...factory.disclosed]) }
    },

    /** Treasury adds USDCx to the pool: starting reserves and recapitalization (K6). */
    async addReserves(
      actor: string,
      amount: string,
      inputHoldingCids?: string[],
    ): Promise<PreparedCommand> {
      const s = await reader.snapshot()
      asTreasury(s, actor)
      if (!dec(amount).gt(0)) throw new CommandError('Enter an amount above zero')
      // the wallet's own pick of holdings, checked by its verifier (as for user payments)
      const pay = await userPayment(s, actor, d.usdcx, inputHoldingCids, amount)
      return prepared(
        actor,
        [poolExercise(s, 'Pool_AddReserves', { actor, amount, payment: pay.args })],
        [...core(s), ...pay.disclosed],
      )
    },

    /** Account request: the operator bot opens the account (AccountDirectory, audit V1). */
    async openAccount(user: string): Promise<PreparedCommand> {
      if (await reader.account(user)) throw new CommandError('Account already exists')
      return prepared(
        user,
        [
          {
            CreateCommand: {
              templateId: TEMPLATES.accountRequest,
              createArguments: { operator: d.operator, user },
            },
          },
        ],
        [],
      )
    },

    /** API login: the user signs a Login contract with a nonce (audit V1). */
    async login(user: string, nonce: string, expiresAt: Date): Promise<PreparedCommand> {
      // Login expiry not beyond the cap: the backend will not accept a Login with a distant expiry
      // (§2)
      const cap = new Date(Date.now() + LOGIN_MAX_TTL_MS)
      if (expiresAt > cap) expiresAt = cap
      return prepared(
        user,
        [
          {
            CreateCommand: {
              templateId: TEMPLATES.login,
              createArguments: {
                user,
                operator: d.operator,
                nonce,
                expiresAt: expiresAt.toISOString(),
              },
            },
          },
        ],
        [],
      )
    },

    /** Supply USDCx; the debt is repaid first. "max" or all: repay the whole debt. */
    async supply(
      user: User,
      amount: AmountInput,
      inputHoldingCids?: string[],
      all = false,
    ): Promise<PreparedCommand> {
      return supplyBase(user, amount, all, inputHoldingCids)
    },

    /** Repay: supply that needs a debt; "max" or all repays it exactly. */
    async repay(
      user: User,
      amount: AmountInput,
      inputHoldingCids?: string[],
      all = false,
    ): Promise<PreparedCommand> {
      const { snapshot: s, account } = await base(keyOf(user))
      if (balances(s, account).now.gte(0)) throw new CommandError('No debt to repay')
      return supplyBase(user, amount, all, inputHoldingCids)
    },

    /**
     * Withdraw from the deposit (Pool_WithdrawBase, allowBorrow = False): never a loan (risk 7).
     * all: the whole deposit as of the transaction; operator holdings cover it at the deadline.
     */
    async withdraw(user: User, amount: AmountInput, all = false): Promise<PreparedCommand> {
      const { snapshot: s, account } = await base(keyOf(user))
      if (poolNumbers(s, new Date()).netReserves.lt(0))
        throw new ProtocolStateError('WITHDRAWALS_WAIT_FOR_RECAPITALIZATION')
      const b = balances(s, account)
      const full = all || amount === MAX
      if (b.now.lte(0)) throw new CommandError('Nothing supplied')
      // B-12: no withdrawal above the deposit: a loan is the Borrow operation
      if (!full && dec(amount).gt(b.later))
        throw new CommandError(
          `You can withdraw up to ${b.now.toFixed(10, 1)}; use Borrow to take a loan`,
        )
      const payout = await operatorPayout(
        s,
        d.usdcx,
        full ? b.later.toFixed(10, 0) : amount,
        partyOf(user),
      )
      return prepared(
        partyOf(user),
        [
          poolExercise(s, 'Pool_WithdrawBase', {
            user: partyOf(user),
            pauseCid: s.pause.contractId,
            accountCid: account.contractId,
            amount: full ? b.now.toFixed(10, 1) : amount,
            full,
            allowBorrow: false,
            prices: noPrices,
            payout: payout.args,
          }),
        ],
        [...core(s), ...payout.disclosed],
      )
    },

    /**
     * Borrow (Pool_WithdrawBase, allowBorrow = True): the deposit first, then a debt. Every price
     * the account's collateral needs goes with the command.
     */
    async borrow(user: User, amount: AmountInput): Promise<PreparedCommand> {
      if (amount === MAX) throw new CommandError('Enter an amount to borrow')
      const { snapshot: s, account } = await base(keyOf(user))
      if (poolNumbers(s, new Date()).netReserves.lt(0))
        throw new ProtocolStateError('WITHDRAWALS_WAIT_FOR_RECAPITALIZATION')
      // B-12: the contract rejects a borrow above what is available; reject before the payout
      const view = accountView(d, s, account, new Date())
      const available = dec(view?.summary.maxBorrow ?? '0')
      if (dec(amount).gt(available))
        throw new CommandError(
          available.lte(0)
            ? 'Nothing to borrow: deposit collateral or wait for a valid price'
            : `You can borrow up to ${available.toFixed(10, 1)}`,
        )
      const prices = priceArgs(s, account.payload)
      const payout = await operatorPayout(s, d.usdcx, amount, partyOf(user))
      return prepared(
        partyOf(user),
        [
          poolExercise(s, 'Pool_WithdrawBase', {
            user: partyOf(user),
            pauseCid: s.pause.contractId,
            accountCid: account.contractId,
            amount,
            full: false,
            allowBorrow: true,
            prices: prices.args,
            payout: payout.args,
          }),
        ],
        [...core(s), ...prices.disclosed, ...payout.disclosed],
      )
    },

    /** Supply collateral (Pool_SupplyCollateral): no price needed, never paused. */
    async depositCollateral(
      user: User,
      marketId: MarketId,
      amount: AmountInput,
      inputHoldingCids?: string[],
    ): Promise<PreparedCommand> {
      if (amount === MAX) throw new CommandError('Enter an amount to deposit')
      const { snapshot: s, account } = await base(keyOf(user))
      const pay = await userPayment(
        s,
        partyOf(user),
        collateralInstrument(s, marketId),
        inputHoldingCids,
        amount,
      )
      return prepared(
        partyOf(user),
        [
          poolExercise(s, 'Pool_SupplyCollateral', {
            user: partyOf(user),
            accountCid: account.contractId,
            marketId,
            amount,
            payment: pay.args,
          }),
        ],
        [...core(s), ...pay.disclosed],
      )
    },

    /** Withdraw collateral (Pool_WithdrawCollateral): with a debt the rest must cover it. */
    async withdrawCollateral(
      user: User,
      marketId: MarketId,
      amount: AmountInput,
    ): Promise<PreparedCommand> {
      const { snapshot: s, account } = await base(keyOf(user))
      // max: all collateral of the asset at token precision (10 decimals, down)
      const collateral = dec(collateralOf(account.payload).get(marketId) ?? '0')
      const value = amount === MAX ? collateral.toFixed(10, 1) : amount
      // B-12: the contract will not withdraw more than the collateral, so holdings for that are not
      // disclosed
      if (dec(value).lte(0)) throw new CommandError('No collateral to withdraw')
      if (dec(value).gt(collateral))
        throw new CommandError(`You can withdraw up to ${collateral.toFixed(10, 1)}`)
      const prices = priceArgs(s, account.payload)
      const payout = await operatorPayout(
        s,
        collateralInstrument(s, marketId),
        value,
        partyOf(user),
      )
      return prepared(
        partyOf(user),
        [
          poolExercise(s, 'Pool_WithdrawCollateral', {
            user: partyOf(user),
            pauseCid: s.pause.contractId,
            accountCid: account.contractId,
            marketId,
            amount: value,
            prices: prices.args,
            payout: payout.args,
          }),
        ],
        [...core(s), ...prices.disclosed, ...payout.disclosed],
      )
    },

    /**
     * Buy absorbed collateral (Pool_BuyCollateral, K5): the buyer pays USDCx and receives at least
     * `minCollateral`. The operator payout covers the quote at current prices.
     */
    async buyCollateral(
      buyer: string,
      marketId: MarketId,
      amount: string,
      minCollateral: string,
      inputHoldingCids?: string[],
    ): Promise<PreparedCommand> {
      const s = await reader.snapshot()
      const roles = s.config.payload.roles
      if (buyer !== roles.backstop && !roles.liquidators.includes(buyer))
        throw new CommandError('Only an approved buyer can buy absorbed collateral')
      if (!dec(amount).gt(0)) throw new CommandError('Enter an amount above zero')
      const sale = saleView(s, d, marketId, new Date())
      if (!sale) throw new CommandError(`Unknown asset ${marketId}`)
      const out = quoteCollateral(sale, amount)
      if (!out) throw new CommandError('No usable price for this asset now')
      if (sale.costOfAll && dec(amount).gt(sale.costOfAll))
        throw new CommandError(
          `Everything for sale costs ${sale.costOfAll} USDCx: pay that to buy all ${sale.available} ${marketId}`,
        )
      // every USDCx operation is at least 1, except one that clears the stock (contract 1.0.2)
      if (dec(amount).lt(1) && dec(out).lt(sale.available))
        throw new CommandError('A purchase is at least 1 USDCx, unless it buys everything for sale')
      if (dec(out).isZero()) throw new CommandError('This amount buys nothing')
      if (dec(out).lt(minCollateral))
        throw new CommandError(`${amount} USDCx buys ${out} ${marketId}, less than the minimum`)
      const instrument = collateralInstrument(s, marketId)
      const collateralFeed = feedFor(s, instrument)
      const debtFeed = debtFeedOf(s)
      if (!collateralFeed) throw new CommandError('Price feeds are not published')
      const pay = await userPayment(s, buyer, d.usdcx, inputHoldingCids, amount)
      const payout = await operatorPayout(s, instrument, out, buyer)
      return prepared(
        buyer,
        [
          poolExercise(s, 'Pool_BuyCollateral', {
            buyer,
            pauseCid: s.pause.contractId,
            marketId,
            amount,
            minCollateral,
            collateralFeedCid: collateralFeed.contractId,
            debtFeedCid: debtFeed.contractId,
            payment: pay.args,
            payout: payout.args,
          }),
        ],
        [
          ...core(s),
          toDisclosed(collateralFeed),
          toDisclosed(debtFeed),
          ...pay.disclosed,
          ...payout.disclosed,
        ],
      )
    },

    /**
     * Absorb an account (Pool_Absorb): the operator submits it itself; every collateral feed and
     * the USDCx feed go with it. No disclosure: the operator signs everything it reads.
     */
    absorbCommand(s: Snapshot, account: ActiveContract<AccountPayload>): Command {
      const prices = priceArgs(s, account.payload)
      return poolExercise(s, 'Pool_Absorb', {
        pauseCid: s.pause.contractId,
        accountCid: account.contractId,
        prices: prices.args,
      })
    },

    /**
     * Pause flags (PauseState_Set): the guardian from ProtocolConfig (§4) replaces the flags; the
     * pool is not touched, so a pause does not wait for user operations (risk 13).
     */
    /**
     * One pause flag (PauseState_SetFlag, 1.0.2): the guardian signs only the flag it changes, so a
     * stale view of the others cannot undo another pause.
     */
    async setPause(flag: PauseFlagName, paused: boolean) {
      const s = await reader.snapshot()
      const guardian = s.config.payload.roles.guardian
      return prepared(
        guardian,
        [
          {
            ExerciseCommand: {
              templateId: TEMPLATES.pauseState,
              contractId: s.pause.contractId,
              choice: 'PauseState_SetFlag',
              choiceArgument: { flag: PAUSE_FLAG_CONSTRUCTORS[flag], paused },
            },
          },
        ],
        [],
      )
    },
  }
}

export type CommandBuilder = ReturnType<typeof createCommandBuilder>
