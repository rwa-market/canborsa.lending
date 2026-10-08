/** Reading protocol state from the ledger as the operator and the oracle. */
import {
  type DecManCouncilView,
  isEvmAddress,
  loopPartyOf,
  loopSubject,
  type WalletBalances,
} from '@lending/shared'
import type { Deployment, Instrument } from '../deployment.ts'
import { type ActiveContract, type LedgerClient } from '../ledger/client.ts'
import { NoCredentialError } from '../ledger/credentials.ts'
import { DECMAN, INTERFACES, TEMPLATES } from '../ledger/ids.ts'
import { dec } from './math.ts'
import {
  type AccountPayload,
  type AccountRequestPayload,
  type ConfigPayload,
  type CouncilRotationPayload,
  type GovernanceCouncilPayload,
  type HoldingView,
  type IncomeProposalPayload,
  type ParameterChangeProposalPayload,
  type EvmDirectoryPayload,
  type EvmWalletPayload,
  type LoopDirectoryPayload,
  type LoopWalletPayload,
  type LoginPayload,
  type Market,
  type MarketParams,
  type PauseStatePayload,
  type PoolPayload,
  type PriceFeedPayload,
  type ReserveAttestationPayload,
  type Roles,
  sameInstrument,
} from './types.ts'

export interface Snapshot {
  config: ActiveContract<ConfigPayload>
  pool: ActiveContract<PoolPayload>
  /** Pause flags of the config's guardian (K7): pausable operations read them */
  pause: ActiveContract<PauseStatePayload>
  markets: Map<string, Market>
  marketParams: Map<string, MarketParams>
  feeds: ActiveContract<PriceFeedPayload>[]
  attestations: ActiveContract<ReserveAttestationPayload>[]
  /** Featured App right from the config: the user gets it via disclosure (§10) */
  featuredAppRight: ActiveContract | null
}

function single<T>(xs: ActiveContract<T>[], what: string): ActiveContract<T> {
  const x = xs[0]
  if (!x) throw new Error(`${what} not deployed`)
  return x
}

/**
 * Cache with a TTL and a shared in-flight request: a hundred concurrent GET /pool make one ACS read
 * (B-4). Errors are not cached.
 */
/**
 * Versioned cache for ttlMs: `get(version)` re-reads if the version changed. The version is
 * the participant's ledger-end: after any transaction (user wallet, bot, backend command)
 * a read sees the write immediately, and without writes the cache holds for the TTL.
 */
export function ttlCache<T>(ttlMs: number, load: () => Promise<T>, now: () => number = Date.now) {
  type Version = number | string | undefined
  let value: { at: number; version: Version; v: T } | null = null
  let inflight: { version: Version; p: Promise<T> } | null = null
  return {
    get(version?: Version): Promise<T> {
      if (value && value.version === version && now() - value.at < ttlMs)
        return Promise.resolve(value.v)
      if (inflight && inflight.version === version) return inflight.p
      const p = load()
        .then((v) => {
          value = { at: now(), version, v }
          return v
        })
        .finally(() => {
          if (inflight?.p === p) inflight = null
        })
      inflight = { version, p }
      return p
    },
    clear() {
      value = null
    },
  }
}

/** "Largest first" order by Decimal (B-13): string comparison confuses fractional amounts. */
export const byAmountDesc = (a: { view: { amount: string } }, b: { view: { amount: string } }) =>
  dec(b.view.amount).cmp(a.view.amount)

export function createReader(
  ledger: LedgerClient,
  d: Deployment,
  opts: { cacheMs?: number; rolesRefreshMs?: number; now?: () => number } = {},
) {
  const pool = async () =>
    single(await ledger.query<PoolPayload>(d.operator, { templateId: TEMPLATES.pool }), 'pool')
  const config = async () =>
    single(
      await ledger.query<ConfigPayload>(d.operator, { templateId: TEMPLATES.config }),
      'config',
    )
  const directory = async () =>
    single(
      await ledger.query(d.operator, { templateId: TEMPLATES.accountDirectory }),
      'account directory',
    )

  async function snapshot(): Promise<Snapshot> {
    // Feeds and attestations are read by the operator (an observer): the API needs no oracle rights
    // (B-1)
    const [c, p, pauses, feeds, attestations] = await Promise.all([
      config(),
      pool(),
      ledger.query<PauseStatePayload>(d.operator, { templateId: TEMPLATES.pauseState }),
      ledger.query<PriceFeedPayload>(d.operator, { templateId: TEMPLATES.priceFeed }),
      ledger.query<ReserveAttestationPayload>(d.operator, {
        templateId: TEMPLATES.reserveAttestation,
      }),
    ])
    // the pool accepts only the flags of the config's guardian (loadPause)
    // After a council changes the guardian the flags are still bound to the old one until the
    // absorber rebinds them (PauseState_Rebind, review 03.10 item 14): read that one meanwhile
    // instead of failing every request
    const current = pauses.filter((x) => x.payload.guardian === c.payload.roles.guardian)
    const pause = single(current.length > 0 ? current : pauses, 'pause flags')
    const rightCid = c.payload.featuredAppRight ?? null
    const featuredAppRight = rightCid
      ? ((await ledger.query(d.operator, { interfaceId: INTERFACES.featuredAppRight })).find(
          (r) => r.contractId === rightCid,
        ) ?? null)
      : null
    return {
      featuredAppRight,
      config: c,
      pool: p,
      pause,
      markets: new Map(p.payload.markets),
      marketParams: new Map(c.payload.marketParams),
      feeds,
      attestations,
    }
  }

  const accounts = () => ledger.query<AccountPayload>(d.operator, { templateId: TEMPLATES.account })

  /** Account by key: the owner's party or an EVM address (0.5.0, ADR-004). */
  async function account(owner: string): Promise<ActiveContract<AccountPayload> | null> {
    return (await accounts()).find((a) => ownerKey(a.payload) === owner) ?? null
  }

  const now = opts.now ?? Date.now
  const snapshotCache = ttlCache(opts.cacheMs ?? 0, snapshot, now)
  const accountsCache = ttlCache(opts.cacheMs ?? 0, accounts, now)
  // Cache version is the ledger-end: a write is visible right after the transaction, not after the
  // TTL
  const ledgerVersion = () => (opts.cacheMs ? ledger.ledgerEnd() : Promise.resolve(undefined))
  /**
   * Snapshot for API reads (GET /pool etc.): cached for seconds. Bots and commands are uncached.
   */
  const cachedSnapshot = async () => snapshotCache.get(await ledgerVersion())
  const cachedAccount = async (owner: string) =>
    (await accountsCache.get(await ledgerVersion())).find((a) => ownerKey(a.payload) === owner) ??
    null

  /**
   * Roles from ProtocolConfig (§4): a role rotation via the council is visible to the backend
   * without a restart. Re-read every rolesRefreshMs; ledger unavailable: the last known ones, and
   * before the first read, from deployment.json.
   */
  const fromDeployment: Roles = {
    operator: d.operator,
    oracle: d.oracle,
    guardian: d.guardian,
    treasury: d.treasury,
    backstop: d.backstop,
    liquidators: [d.liquidator],
  }
  let knownRoles: Roles = fromDeployment
  const rolesCache = ttlCache(
    opts.rolesRefreshMs ?? 30_000,
    async () => {
      knownRoles = (await config()).payload.roles
      return knownRoles
    },
    now,
  )
  async function roles(): Promise<Roles> {
    try {
      return await rolesCache.get()
    } catch {
      return knownRoles
    }
  }

  const accountRequests = () =>
    ledger.query<AccountRequestPayload>(d.operator, { templateId: TEMPLATES.accountRequest })

  const logins = () => ledger.query<LoginPayload>(d.operator, { templateId: TEMPLATES.login })

  /**
   * Free holdings of the party, largest first (F-16). JSON Ledger API 3.5 filters the ACS only by
   * party and template or interface, not by contract fields: owner, lock and InstrumentId are
   * checked here, and reads are paginated (active-contracts-page, B-4). Parties without a
   * credential on this node (Loop wallet on testnet) are invisible to the backend: empty list.
   */
  async function ownHoldings(party: string) {
    let hs: ActiveContract[]
    try {
      hs = await ledger.query(party, { interfaceId: INTERFACES.holding })
    } catch (err) {
      if (err instanceof NoCredentialError) return []
      throw err
    }
    return hs
      .map((h) => ({ contract: h, view: h.interfaceView as HoldingView }))
      .filter((h) => h.view && h.view.owner === party && !h.view.lock)
      .sort(byAmountDesc)
  }

  /** Free holdings of the party for an instrument, largest first. */
  async function holdings(party: string, instrument: Instrument) {
    return (await ownHoldings(party)).filter((h) => sameInstrument(h.view.instrumentId, instrument))
  }

  /** Wallet balance per protocol instrument: one ACS read for all instruments (F-16). */
  /** Wallet of an EVM address: shares of the custodian's holdings (0.5.0). No wallet: null. */
  async function evmWallet(address: string): Promise<ActiveContract<EvmWalletPayload> | null> {
    const ws = await ledger.query<EvmWalletPayload>(d.operator, {
      templateId: TEMPLATES.evmWallet,
    })
    return (
      ws.find((w) => w.payload.address === address && w.payload.operator === d.operator) ?? null
    )
  }

  async function evmDirectory(): Promise<ActiveContract<EvmDirectoryPayload> | null> {
    const ds = await ledger.query<EvmDirectoryPayload>(d.operator, {
      templateId: TEMPLATES.evmDirectory,
    })
    return ds.find((x) => x.payload.custody === d.evm?.custody) ?? null
  }

  /** Wallet of a Loop party (0.7.0): shares of the custodian's holdings. No wallet: null. */
  async function loopWallet(party: string): Promise<ActiveContract<LoopWalletPayload> | null> {
    const ws = await ledger.query<LoopWalletPayload>(d.operator, {
      templateId: TEMPLATES.loopWallet,
    })
    return ws.find((w) => w.payload.party === party && w.payload.operator === d.operator) ?? null
  }

  async function loopDirectory(): Promise<ActiveContract<LoopDirectoryPayload> | null> {
    const ds = await ledger.query<LoopDirectoryPayload>(d.operator, {
      templateId: TEMPLATES.loopDirectory,
    })
    return ds.find((x) => x.payload.custody === d.evm?.custody) ?? null
  }

  /**
   * Wallet balance: EVM address and `loop:<party>` are shares at the custodian, otherwise the
   * party's holdings.
   */
  async function walletBalances(party: string): Promise<WalletBalances> {
    const loopParty = loopPartyOf(party)
    if (isEvmAddress(party) || loopParty) {
      const w = loopParty ? await loopWallet(loopParty) : await evmWallet(party)
      const sum = (i: Instrument) =>
        dec(w?.payload.balances.find(([k]) => sameInstrument(k, i))?.[1] ?? '0').toFixed(10)
      return balancesBy(sum)
    }
    const own = await ownHoldings(party)
    const sum = (i: Instrument) =>
      own
        .filter((h) => sameInstrument(h.view.instrumentId, i))
        .reduce((acc, h) => acc.plus(h.view.amount), dec(0))
        .toFixed(10)
    return balancesBy(sum)
  }

  function balancesBy(sum: (i: Instrument) => string): WalletBalances {
    return { USDCx: sum(d.usdcx), CC: sum(d.cc), CBTC: sum(d.cbtc) }
  }

  // Council: the operator signs the council, proposals and rotations, so it sees all (0.4.0)
  const councils = () =>
    ledger.query<GovernanceCouncilPayload>(d.operator, { templateId: TEMPLATES.governanceCouncil })
  const proposals = () =>
    ledger.query<ParameterChangeProposalPayload>(d.operator, {
      templateId: TEMPLATES.parameterChangeProposal,
    })
  const rotations = () =>
    ledger.query<CouncilRotationPayload>(d.operator, { templateId: TEMPLATES.councilRotation })
  const incomeProposals = () =>
    ledger.query<IncomeProposalPayload>(d.operator, { templateId: TEMPLATES.incomeProposal })

  /**
   * A council of one party that runs BitSafe GovernanceRules (review 03.10, item 25). Read as that
   * party: it works only where this node hosts it and the backend may read for it; otherwise null.
   */
  async function decman(party: string): Promise<DecManCouncilView | null> {
    try {
      const rules = (
        await ledger.query<{ governanceParty: string; members: unknown; threshold: string }>(
          party,
          {
            templateId: DECMAN.rules,
          },
        )
      ).find((r) => r.payload.governanceParty === party)
      if (!rules) return null
      const [actions, confirmations] = await Promise.all([
        ledger.query<unknown>(party, { interfaceId: DECMAN.action }),
        ledger.query<{ confirmer: string; actionProposalCid: string; expiresAt: string }>(party, {
          templateId: DECMAN.confirmation,
        }),
      ])
      const now = Date.now()
      return {
        governanceParty: party,
        members: setMembers(rules.payload.members),
        threshold: Number(rules.payload.threshold),
        actions: actions.flatMap((a) => {
          const v = a.interfaceView as
            | {
                governanceParty?: string
                proposer?: string
                actionLabel?: string
                description?: string
              }
            | undefined
          if (!v || v.governanceParty !== party) return []
          return [
            {
              contractId: a.contractId,
              label: v.actionLabel ?? '',
              description: v.description ?? '',
              proposer: v.proposer ?? '',
              confirmations: [
                ...new Set(
                  confirmations
                    .filter(
                      (c) =>
                        c.payload.actionProposalCid === a.contractId &&
                        Date.parse(c.payload.expiresAt) > now,
                    )
                    .map((c) => c.payload.confirmer),
                ),
              ],
            },
          ]
        }),
      }
    } catch {
      // not hosted here, no read right, or the DecMan packages are not on this node
      return null
    }
  }

  return {
    pool,
    config,
    directory,
    snapshot,
    cachedSnapshot,
    cachedAccount,
    roles,
    accounts,
    account,
    accountRequests,
    logins,
    holdings,
    walletBalances,
    evmWallet,
    evmDirectory,
    loopWallet,
    loopDirectory,
    councils,
    decman,
    proposals,
    rotations,
    incomeProposals,
  }
}

export type Reader = ReturnType<typeof createReader>

/**
 * Feed and attestation of the current oracle from ProtocolConfig (§4, 0.4.0): after an oracle
 * rotation old feeds are still in the ACS, but the contract rejects them
 * (`price feed: wrong oracle`). No feed from the new oracle: undefined, not someone else's feed.
 */
export const feedFor = (s: Snapshot, i: Instrument) =>
  s.feeds.find(
    (f) =>
      f.payload.oracle === s.config.payload.roles.oracle &&
      sameInstrument(f.payload.instrumentId, i),
  )
export const attestationFor = (s: Snapshot, i: Instrument) =>
  s.attestations.find(
    (a) =>
      a.payload.oracle === s.config.payload.roles.oracle &&
      sameInstrument(a.payload.instrumentId, i),
  )

/** Trusted factory of the instrument from the config (audit K1). */
export function trustedFactory(s: Snapshot, i: Instrument): string {
  const f = s.config.payload.transferFactories.find(([k]) => sameInstrument(k, i))?.[1]
  if (!f) throw new Error(`no trusted factory for ${i.id}`)
  return f
}

/** Collateral of an account per asset, positive amounts only. */
export function collateralOf(account: AccountPayload | undefined | null): Map<string, string> {
  return new Map((account?.collateral ?? []).filter(([, a]) => dec(a).gt(0)))
}

/**
 * Collateral instrument of an asset from ProtocolConfig: assets are listed by the council, not
 * deployment.json.
 */
export function collateralInstrument(s: Snapshot, marketId: string): Instrument {
  const mp = s.marketParams.get(marketId)
  if (!mp) throw new Error(`unknown market ${marketId}`)
  return mp.collateralInstrument
}

/**
 * Account key: the EVM address of a wallet account (0.5.0, ADR-004), `loop:<party>` of a Loop
 * account (0.7.0) or the owner's party.
 */
export const ownerKey = (a: Pick<AccountPayload, 'owner' | 'evmAddress' | 'loopParty'>) =>
  a.evmAddress || (a.loopParty ? loopSubject(a.loopParty) : a.owner)

/** DA.Set in the JSON Ledger API: `{map: [[party, {}], …]}`; a plain list is accepted too. */
export function setMembers(v: unknown): string[] {
  // an array has its own .map method: only a record carries the Set's entries
  const m = Array.isArray(v) ? v : (v as { map?: unknown } | null)?.map
  if (!Array.isArray(m)) return []
  return m.flatMap((e) => (Array.isArray(e) ? [String(e[0])] : typeof e === 'string' ? [e] : []))
}
