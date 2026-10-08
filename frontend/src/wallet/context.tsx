import {
  type AppConfig,
  type InstrumentId,
  loopPartyOf,
  loopSubject,
  type PreparedCommand,
} from '@lending/shared'
import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { api, ApiError, queryKeys, setSessionActive, setUnauthorizedHandler } from '@/lib/api'
import { type Holding, pickInputs } from './holdings'
import { loopConfigOf } from './loop-config'
import { type LoopPreparedResponse, verifyLoopLogin, verifyLoopPrepared } from './loop-verify'
import { checkNetwork, expectedNetwork, type NetworkVerdict } from './network'
import {
  expiryDelay,
  liveSession,
  purgeLegacyTokens,
  rememberedWallet,
  rememberWallet,
  restorePlan,
  type ServerSession,
  type WalletKind,
} from './session'
import {
  CommandRejected,
  type Intent,
  type SignSummary,
  type VerifyContext,
  verifyPrepared,
} from './verify'

export type { WalletKind }

export interface WalletState {
  kind: WalletKind | null
  party: string | null
  /** API session issued: can read own data and prepare commands */
  signedIn: boolean
  connecting: boolean
  error: string | null
  /** What is being signed now: for the "You are signing" dialog */
  signing: SignSummary | null
  /**
   * Node wallet: the verified command waits for the user's explicit confirmation (review 03.10,
   * item 18): the node signs with its token at once, so without this one click would execute it
   */
  confirming: SignSummary | null
  /** Answer the pending confirmation: true signs and submits, false cancels */
  answerConfirm: (ok: boolean) => void
  /**
   * Node wallet: only protocol roles on the /operator page (guardian, treasury, council,
   * liquidator): their parties live on our node, Loop will not sign for them. Without a node token:
   * redirect to OIDC sign-in (the page returns to /auth/callback); with a token: protocol sign-in
   * as the chosen party (Login signature).
   */
  connectNode: (party?: string) => Promise<void>
  /**
   * Loop wallet: the only user sign-in ("Connect wallet"): a QR dialog or
   * the Loop popup, signing the sign-in text (Ed25519). The LoopWallet account opens under the
   * custodian on first sign-in: Loop does not run our DARs.
   */
  connectLoop: () => Promise<void>
  disconnect: () => Promise<void>
  /**
   * Check the command against the intent (F-1) and the network (F-4), show what is being signed,
   * and pass it to the wallet with the intent's commandId (F-6). Throws if anything does not match.
   */
  submit: (
    prepared: PreparedCommand,
    intent: Intent,
    commandId: string,
    /** An automatic retry: why the Confirm dialog is back */
    retry?: string,
  ) => Promise<{ updateId: string }>
  /**
   * Loop wallet operation: rebuild the text from the intent, show it as is,
   * sign with signMessage and submit. The backend verifies the signature, the custodian executes.
   */
  submitLoop: (
    p: LoopPreparedResponse,
    intent: Intent,
    /** An automatic retry: why Loop asks again (review 08.10, item 8) */
    retry?: string,
  ) => Promise<{ updateId: string }>
  /** Loop: bring the window with the pending request to the front; false if the browser blocked it */
  openLoopWallet: () => Promise<boolean>
  /** Node wallet: holdings to cover the amount (largest first). Dev: the backend picks them. */
  inputHoldings: (instrument: InstrumentId, target: string | null) => Promise<string[] | undefined>
  /** Node wallet: holding amounts for the preview. Dev: the backend computes them itself. */
  walletAmounts: (instrument: InstrumentId) => Promise<string[] | undefined>
  /** Node wallet: holdings for the balance. Dev: undefined, /wallet gives the balance. */
  walletHoldings: (instrument: InstrumentId) => Promise<Holding[] | undefined>
}

const WalletContext = createContext<WalletState | null>(null)

const node = () => import('./node')
// The Loop SDK is loaded only for the Loop wallet
/** Loaded Loop module: a click on Open Loop reaches window.open synchronously, inside the gesture */
let loopModule: typeof import('./loop') | null = null
const loopWallet = async () => (loopModule ??= await import('./loop'))

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Values pinned at build time: the API cannot substitute them (F-1, F-4). */
const PINNED_OPERATOR = (import.meta.env.VITE_OPERATOR_PARTY as string | undefined)?.trim() || null

/** Account operations: the account comes from the user's node, checked against the operator. */
const ACCOUNT_OPS = new Set<Intent['kind']>([
  'supply',
  'withdraw',
  'deposit-collateral',
  'withdraw-collateral',
  'borrow',
  'repay',
])

/** Retry /auth/login: the operator sees Login later than the user's validator (F-7). */
const LOGIN_RETRY_MS = [0, 500, 1_000, 2_000, 3_000, 4_000]

const PINNED_NETWORK =
  (import.meta.env.VITE_EXPECTED_NETWORK_ID as string | undefined)?.trim() || null

/** Node wallet network: the hackcanton node is connected to DevNet. */
export const NODE_NETWORK = 'canton:devnet'

/**
 * Network verdict (F-4): protocol, build and wallet are on one network. The node is DevNet, a Loop
 * account uses the network from /config.loop. A dev build allows a server without networkId.
 */
export function walletNetworkVerdict(
  config: AppConfig | undefined,
  kind: WalletKind | null,
): NetworkVerdict {
  const expected = expectedNetwork(config)
  return checkNetwork({
    expected,
    pinned: PINNED_NETWORK,
    wallet:
      kind === 'node'
        ? NODE_NETWORK
        : kind === 'loop'
          ? (loopConfigOf(config)?.network ?? null)
          : expected,
    walletConnected: true,
    allowUndeclared: import.meta.env.DEV,
  })
}

export function operatorOf(config: AppConfig): string {
  if (PINNED_OPERATOR && PINNED_OPERATOR !== config.roles.operator)
    throw new CommandRejected('the server reports another protocol operator than this app')
  return PINNED_OPERATOR ?? config.roles.operator
}

/** configCid from the single command's arguments (before checks: the verifier checks it itself). */
function configCidOf(p: PreparedCommand): string | null {
  const c = (p.commands as { ExerciseCommand?: { choiceArgument?: { configCid?: unknown } } }[])[0]
  const cid = c?.ExerciseCommand?.choiceArgument?.configCid
  return typeof cid === 'string' ? cid : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function WalletProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<WalletKind | null>(null)
  const [party, setParty] = useState<string | null>(null)
  /** Cookie session expiry from the server (GET /auth/session); the page has no token (F-15) */
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signing, setSigning] = useState<SignSummary | null>(null)
  const [confirming, setConfirming] = useState<SignSummary | null>(null)
  const confirmResolve = useRef<((ok: boolean) => void) | null>(null)
  const answerConfirm = useCallback((ok: boolean) => {
    confirmResolve.current?.(ok)
    confirmResolve.current = null
    setConfirming(null)
  }, [])
  /** Show the summary and wait for Confirm / Cancel. */
  const askConfirm = useCallback(
    (summary: SignSummary) =>
      new Promise<boolean>((resolve) => {
        confirmResolve.current?.(false)
        confirmResolve.current = resolve
        setConfirming(summary)
      }),
    [],
  )
  const signedIn = expiresAt !== null

  const config = useCallback(
    () => qc.fetchQuery({ queryKey: queryKeys.config, queryFn: api.config, staleTime: 60_000 }),
    [qc],
  )

  /** The previous party's data must not survive a session change. */
  const forgetPartyData = useCallback(() => {
    for (const key of [
      'account',
      'history',
      'wallet',
      'liquidator',
      'preview',
      'treasury',
      'governance',
    ])
      qc.removeQueries({ queryKey: [key] })
  }, [qc])

  const establish = useCallback((k: WalletKind, s: ServerSession) => {
    setSessionActive(true)
    setKind(k)
    setParty(s.party)
    setExpiresAt(s.expiresAt)
    rememberWallet(k)
  }, [])

  /** Cookie session after sign-in: the server confirms the party and expiry. */
  const confirmSession = useCallback(async (p: string): Promise<ServerSession> => {
    const s = liveSession(await api.session())
    if (!s) throw new Error('The browser did not keep the sign-in. Allow cookies for this site.')
    if (s.party !== p) throw new Error('The server signed you in as another party. Sign in again.')
    return s
  }, [])

  /** Reset the session without calling the wallet: 401, account change, token expiry. */
  const reset = useCallback(
    (why?: string) => {
      setSessionActive(false)
      setKind(null)
      setParty(null)
      setExpiresAt(null)
      setSigning(null)
      rememberWallet(null)
      forgetPartyData()
      // Only the server clears the cookie (httpOnly); a logout error does not block the reset
      void api.logout().catch(() => undefined)
      if (why) toast.info(why)
    },
    [forgetPartyData],
  )

  // 401 on a request with a token: the session is invalid (F-8)
  useEffect(() => {
    setUnauthorizedHandler(() => reset('Your session expired. Sign in again.'))
    return () => setUnauthorizedHandler(null)
  }, [reset])

  // The session expiry is known from the server: reset the session when it expires (F-15)
  useEffect(() => {
    if (!expiresAt) return
    const t = setTimeout(
      () => reset('Your session expired. Sign in again.'),
      expiryDelay(expiresAt),
    )
    return () => clearTimeout(t)
  }, [expiresAt, reset])

  // Reload: the server knows the session (cookie). A user restores it only via
  // Loop; the node wallet only on /operator (and its sign-in /auth/callback), and it lives only
  // while the OIDC sign-in is still valid. Otherwise the cookie is discarded
  useEffect(() => {
    purgeLegacyTokens()
    let alive = true
    void (async () => {
      const session = liveSession(await api.session().catch(() => null))
      if (!alive || !session) return
      const plan = restorePlan(session, rememberedWallet(), window.location.pathname)
      try {
        if (plan === 'loop') {
          const lc = loopConfigOf(await config())
          const a = lc ? await (await loopWallet()).loopRestore(lc.sdkNetwork) : null
          if (a && loopSubject(a.party) === session.party) {
            if (alive) establish('loop', session)
            return
          }
        }
        if (plan === 'node' || plan === 'node-callback') {
          // the node token lives only in memory: after a reload, a silent OIDC sign-in;
          // /auth/callback returns the token and calls connectNode again for the same party
          if (plan === 'node-callback') return
          const m = await node()
          if (m.nodeSignedIn()) {
            if (alive) establish('node', session)
            return
          }
          await m.nodeLogin({ silent: true, next: window.location.pathname })
          return
        }
      } catch {
        // the wallet did not respond: the session is not restored
      }
      if (alive) {
        rememberWallet(null)
        void api.logout().catch(() => undefined)
      }
    })()
    return () => {
      alive = false
    }
  }, [config, establish])

  // Loop switched accounts or the Loop session ended: this party's session is no longer ours
  useEffect(() => {
    if (kind !== 'loop' || !party) return
    let off: (() => void) | undefined
    let alive = true
    void loopWallet()
      .then((m) => {
        const unsubscribe = m.loopSubscribe((p) => {
          if (!alive) return
          if (!p) reset('Your Loop session ended. Connect Loop again.')
          else if (loopSubject(p) !== party)
            reset('Loop switched to another account. Sign in again.')
        })
        if (alive) off = unsubscribe
        else unsubscribe()
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off?.()
    }
  }, [kind, party, reset])

  /** Check and sign as k/p. Shared by sign-in and operations. */
  const sign = useCallback(
    async (
      k: WalletKind,
      p: string,
      prepared: PreparedCommand,
      intent: Intent,
      commandId: string,
      retry?: string,
    ): Promise<{ updateId: string }> => {
      const cfg = await config()
      const operator = operatorOf(cfg)
      let accountCid: string | null | undefined
      let protocolConfig: VerifyContext['config']
      if (k === 'node') {
        const m = await node()
        if (!m.nodeSignedIn())
          throw new CommandRejected('your node wallet session ended; sign in again')
        // Network (F-4): the protocol is on the wallet node's network and synchronizer
        const v = walletNetworkVerdict(cfg, 'node')
        if (!v.ok) throw new CommandRejected(v.reason)
        const want = cfg.network?.synchronizerId
        if (want && !(await m.nodeSynchronizers(p)).includes(want))
          throw new CommandRejected('your node is not connected to the protocol synchronizer')
        if (ACCOUNT_OPS.has(intent.kind)) {
          accountCid = await m.nodeAccount(p, operator)
          if (!accountCid)
            throw new CommandRejected('your lending account is not visible on your node')
        }
        // The faucet transfer is checked against the contract on the user's node, not the backend
        // Council proposal: unchanged params are checked against the config on the member's node
        if (intent.kind === 'council-propose') {
          const configCid = configCidOf(prepared)
          protocolConfig = configCid ? await m.nodeConfig(p, configCid) : null
          if (!protocolConfig)
            throw new CommandRejected('the protocol config is not visible on your node')
        }
        if (intent.kind === 'accept-transfer')
          intent = { ...intent, offer: await m.nodeOffer(p, intent.offerCid) }
      }
      const summary = verifyPrepared(prepared, intent, {
        party: p,
        operator,
        accountCid,
        config: protocolConfig,
        now: new Date(),
      })
      // The sign-in Login is the sign-in click itself; everything else waits for an explicit Confirm
      if (intent.kind !== 'login' && !(await askConfirm(retry ? { ...summary, retry } : summary)))
        throw Object.assign(new Error('User cancelled the operation'), { code: 'USER_REJECTED' })
      setSigning(summary)
      try {
        return await (await node()).nodeSubmit(prepared, p, commandId)
      } finally {
        setSigning(null)
      }
    },
    [config, askConfirm],
  )

  const connectNode = useCallback(
    async (chosen?: string) => {
      setConnecting(true)
      setError(null)
      try {
        const m = await node()
        if (!m.nodeSignedIn()) {
          await m.nodeLogin({ next: window.location.pathname })
          return
        }
        const { primary, parties } = await m.nodeParties()
        const p = chosen ?? primary ?? parties[0]
        if (!p || !parties.includes(p))
          throw new Error(
            'Your node account has no party yet. Open the node wallet and onboard first.',
          )
        // a cookie session of this same party is alive: no second Login signature is needed
        const alive = liveSession(await api.session().catch(() => null))
        if (alive && alive.party === p && rememberedWallet() === 'node') {
          establish('node', alive)
          return
        }
        const { nonce, command } = await api.challenge(p)
        await sign('node', p, command, { kind: 'login', nonce }, `lending-login-${nonce}`)
        let loggedIn = false
        for (const delay of LOGIN_RETRY_MS) {
          await sleep(delay)
          try {
            await api.login(p, nonce)
            loggedIn = true
            break
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 401)) throw e
          }
        }
        if (!loggedIn) throw new Error('The protocol did not see your sign-in yet. Try again.')
        const session = await confirmSession(p)
        forgetPartyData()
        establish('node', session)
      } catch (e) {
        setError(message(e))
      } finally {
        setConnecting(false)
      }
    },
    [establish, sign, forgetPartyData, confirmSession],
  )

  const connectLoop = useCallback(async () => {
    setConnecting(true)
    setError(null)
    try {
      const cfg = await config()
      const lc = loopConfigOf(cfg)
      if (!lc) throw new Error('Loop wallets are not enabled on this deployment')
      const v = walletNetworkVerdict(cfg, 'loop')
      if (!v.ok) throw new CommandRejected(v.reason)
      const m = await loopWallet()
      const { party: p, publicKey } = await m.loopConnect(lc.sdkNetwork)
      const { nonce, message } = await api.loopChallenge(p, publicKey)
      // The sign-in text is for this site, this party, this key and this network
      verifyLoopLogin(message, {
        host: window.location.host,
        party: p,
        publicKey,
        network: lc.network,
        nonce,
        now: new Date(),
      })
      setSigning({
        title: 'Sign in with Loop',
        lines: ['Free: a message, not a transaction.'],
        message,
      })
      let signature: string
      try {
        signature = await m.loopSign(p, message)
      } finally {
        setSigning(null)
      }
      await api.loopLogin(p, publicKey, nonce, message, signature)
      // The Loop session is issued to subject loop:<party>, not the Canton party with that ID
      const session = await confirmSession(loopSubject(p))
      forgetPartyData()
      establish('loop', session)
    } catch (e) {
      const cancelled = (e as { code?: string }).code === 'USER_REJECTED'
      if (!cancelled) setError(message(e))
    } finally {
      setConnecting(false)
    }
  }, [config, establish, forgetPartyData, confirmSession])

  const submitLoop = useCallback(
    async (p: LoopPreparedResponse, intent: Intent, retry?: string) => {
      const owner = party ? loopPartyOf(party) : null
      if (kind !== 'loop' || !owner || !signedIn) throw new Error('Connect a wallet first')
      const cfg = await config()
      const lc = loopConfigOf(cfg)
      if (!lc) throw new CommandRejected('Loop wallets are not enabled on this deployment')
      const v = walletNetworkVerdict(cfg, 'loop')
      if (!v.ok) throw new CommandRejected(v.reason)
      const summary = verifyLoopPrepared(p, intent, {
        party: owner,
        operator: operatorOf(cfg),
        network: lc.network,
        custody: lc.custody,
        now: new Date(),
      })
      setSigning(retry ? { ...summary, retry } : summary)
      try {
        const signature = await (await loopWallet()).loopSign(owner, p.message)
        return await api.loopSubmit(p, signature)
      } finally {
        setSigning(null)
      }
    },
    [kind, party, signedIn, config],
  )

  const openLoopWallet = useCallback(
    async () => (loopModule ?? (await loopWallet())).loopOpenWallet(),
    [],
  )

  const disconnect = useCallback(async () => {
    if (kind === 'node') (await node()).nodeLogout()
    if (kind === 'loop') (await loopWallet()).loopDisconnect()
    reset()
  }, [kind, reset])

  const submit = useCallback(
    async (prepared: PreparedCommand, intent: Intent, commandId: string, retry?: string) => {
      if (!kind || !party || !signedIn) throw new Error('Connect a wallet first')
      return sign(kind, party, prepared, intent, commandId, retry)
    },
    [kind, party, signedIn, sign],
  )

  const walletHoldings = useCallback(
    async (instrument: InstrumentId) =>
      kind === 'node' && party ? await (await node()).nodeHoldings(party, instrument) : undefined,
    [kind, party],
  )

  const inputHoldings = useCallback(
    async (instrument: InstrumentId, target: string | null) => {
      const hs = await walletHoldings(instrument)
      return hs ? pickInputs(hs, target) : undefined
    },
    [walletHoldings],
  )

  const walletAmounts = useCallback(
    async (instrument: InstrumentId) => (await walletHoldings(instrument))?.map((h) => h.amount),
    [walletHoldings],
  )

  const value = useMemo<WalletState>(
    () => ({
      kind,
      party,
      signedIn,
      connecting,
      error,
      signing,
      confirming,
      answerConfirm,
      connectNode,
      connectLoop,
      disconnect,
      submit,
      submitLoop,
      openLoopWallet,
      inputHoldings,
      walletAmounts,
      walletHoldings,
    }),
    [
      kind,
      party,
      signedIn,
      connecting,
      error,
      signing,
      confirming,
      answerConfirm,
      connectNode,
      connectLoop,
      disconnect,
      submit,
      submitLoop,
      openLoopWallet,
      inputHoldings,
      walletAmounts,
      walletHoldings,
    ],
  )
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet outside WalletProvider')
  return ctx
}
