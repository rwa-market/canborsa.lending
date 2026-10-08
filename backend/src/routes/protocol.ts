import { randomUUID } from 'node:crypto'
import {
  isEvmAddress,
  isLoopSubject,
  loopLoginMessage,
  loopLoginNonce,
  loopPartyOf,
  loopSubject,
} from '@lending/shared'
import type {
  AccountResponse,
  AppConfig,
  LoopConfig,
  ClaimDepositResponse,
  RealAssetsInfo,
  HistoryEntry,
  HistoryResponse,
  LedgerNetwork,
  BuyerView,
  CollateralQuote,
  TreasuryView,
  WalletBalances,
} from '@lending/shared'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { XreserveClaims } from '../assets/claims.ts'
import { ClaimError } from '../assets/xreserve.ts'
import { createFaucetLimiter } from '../faucet.ts'
import { type Auth, CHALLENGE_TTL_MS } from '../auth.ts'
import {
  MARKETS,
  type Deployment,
  type MarketId,
  type Instrument,
  instrumentsOf,
  marketsOf,
} from '../deployment.ts'
import { type LedgerClient, LedgerError, LedgerUnavailableError } from '../ledger/client.ts'
import { NoCredentialError, SigningForbiddenError } from '../ledger/credentials.ts'
import {
  CommandError,
  type CommandBuilder,
  LOGIN_MAX_TTL_MS,
  type PreparedCommand,
} from '../protocol/commands.ts'
import { RegistryError } from '../protocol/registry.ts'
import { type Evm, EvmSignatureError, evmSigner, type SealedBody } from '../protocol/evm.ts'
import { explainRejection, ProtocolStateError } from '../protocol/errors.ts'
import { type Loop, LoopError, type LoopSealedBody, LoopSignatureError } from '../protocol/loop.ts'
import {
  bindsParty,
  extractSignature,
  LoopKeyError,
  parseLoopPublicKey,
  shapeOf,
  verifyLoopSignature,
} from '../protocol/loop-crypto.ts'
import { applyParamsPatch, type Governance } from '../protocol/governance.ts'
import { dec, money } from '../protocol/math.ts'
import { preview } from '../protocol/preview.ts'
import type { Reader } from '../protocol/reader.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import { accountView, poolNumbers, poolView, quoteCollateral, saleView } from '../protocol/views.ts'
import {
  clearSessionCookie,
  cookieToken,
  csrfViolation,
  headerToken,
  setSessionCookie,
} from '../session.ts'

const decimal = z
  .string()
  .regex(
    /^\d{1,12}(\.\d{1,10})?$/,
    'amount: decimal string, up to 12 integer and 10 fraction digits',
  )
const amount = z.union([decimal, z.literal('max')])
const party = z.string().regex(/^[\w.-]{1,128}::[0-9a-f]{8,128}$/, 'party: hint::fingerprint')
/** EVM address of a wallet account (0.5.0): lowercase, as in the contract. */
const evmAddress = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().regex(/^0x[0-9a-f]{40}$/, 'address: 0x and 40 hex'))
/** Loop party: a hint of up to 185 characters and a SHA-256 fingerprint (1220 and 64 hex). */
const loopParty = z
  .string()
  .regex(/^[\w.-]{1,185}::1220[0-9a-f]{64}$/, 'party: hint::1220 and 64 hex')
/** Loop account: `loop:<party>` (0.7.0). */
const loopAccount = z.string().max(200).refine(isLoopSubject, 'loop:<party>')
/** Whose account: a Canton party, an EVM address or a Loop account. */
const subject = z.union([party, evmAddress, loopAccount])
/** Loop signature: a hex/base64 string or the signMessage response object (format undocumented). */
const loopSignature = z.union([
  z.string().min(1).max(1024),
  z.record(z.string(), z.unknown()).refine((o) => Object.keys(o).length <= 20, 'too many keys'),
])
const evmSignature = z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'signature: 65 bytes hex')
const marketId = z.enum(MARKETS)
const holdings = z.array(z.string().max(200)).max(50).optional()
const amounts = z.array(decimal).max(50).optional()

/** all: the whole deposit (withdraw) or debt (supply, repay); "max" as the amount means the same. */
const all = z.boolean().optional()

const bodies = {
  'open-account': z.object({ party }),
  supply: z.object({ party, amount, all, inputHoldingCids: holdings }),
  repay: z.object({ party, amount, all, inputHoldingCids: holdings }),
  withdraw: z.object({ party, amount, all }),
  borrow: z.object({ party, amount }),
  'deposit-collateral': z.object({ party, marketId, amount, inputHoldingCids: holdings }),
  'withdraw-collateral': z.object({ party, marketId, amount }),
} as const

type Op = keyof typeof bodies

export interface ProtocolDeps {
  deployment: Deployment
  ledger: LedgerClient
  reader: Reader
  commands: CommandBuilder
  auth: Auth
  /** Test token faucet for any logged-in party (TEST_FAUCET, DevNet only) */
  testFaucet?: boolean
  networkId: string | null
  /** Ledger network and synchronizer for /config.network (§10) */
  network?: { name: LedgerNetwork; synchronizerId: string | null }
  history: (party: string) => HistoryEntry[]
  /** EVM wallet accounts (0.5.0, ADR-004); absent: EVM wallet login is disabled */
  evm?: Evm
  /** Loop wallet accounts (0.7.0); absent or disabled: no Loop login */
  loop?: Loop
  /** appName for `loop.init` (/config.loop) */
  loopAppName?: string
  /**
   * Council commands (0.4.0): the backend builds them, council members sign with their own wallet
   */
  governance?: Governance
  /** D-7: command preparations per party per minute; unset: no limit */
  commandRatePerPartyPerMinute?: number
  /**
   * Real assets (ASSET_PROFILE=real): /config.realAssets, EvmTransferOut and
   * EvmRedeem withdrawals in /evm/prepare, xReserve deposit claim. Absent: everything as on DevNet.
   */
  realAssets?: { info: RealAssetsInfo; claims?: XreserveClaims }
  /**
   * F-15: Origins from which non-GET requests with a session cookie are accepted (CORS_ORIGIN,
   * ALLOWED_HOSTS). Unset: non-GET requests with a cookie are always rejected.
   */
  allowedOrigins?: string[]
  /** BUY_TOLERANCE: /buyer/quote minReceive = receive × (1 − tolerance), as the buyer bots use */
  buyTolerance?: string
}

/** Login the backend accepts (§2): with an expiry, not expired and not beyond the cap. */
export const LOGIN_ACCEPT_AHEAD_MS = LOGIN_MAX_TTL_MS + 60_000
export function acceptableLogin(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false
  const t = new Date(expiresAt).getTime()
  return t > now && t <= now + LOGIN_ACCEPT_AHEAD_MS
}

/**
 * D-7: limit on command preparation per party over a sliding minute. The pool is one contract: a
 * stream of small operations by one party makes other parties' commands and liquidations stale.
 * `take` → 0 if allowed (and counts it), otherwise the seconds until the window frees up. The
 * window is in process memory: the two blue/green slots have separate windows.
 */
export function createPartyRateLimiter(perMinute: number, now: () => number = Date.now) {
  const WINDOW = 60_000
  const hits = new Map<string, number[]>()
  let lastSweep = now()
  return {
    take(party: string): number {
      const t = now()
      if (t - lastSweep >= WINDOW) {
        lastSweep = t
        for (const [k, v] of hits) if (v.every((x) => t - x >= WINDOW)) hits.delete(k)
      }
      const recent = (hits.get(party) ?? []).filter((x) => t - x < WINDOW)
      if (recent.length >= perMinute) {
        hits.set(party, recent)
        return Math.max(1, Math.ceil((recent[0]! + WINDOW - t) / 1000))
      }
      recent.push(t)
      hits.set(party, recent)
      return 0
    },
    size: () => hits.size,
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    party?: string
  }
}

export const protocolRoutes =
  (deps: ProtocolDeps): FastifyPluginAsync =>
  async (app) => {
    const { deployment: d, reader, commands, ledger, auth } = deps

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof z.ZodError)
        return reply.status(400).send({ error: 'invalid request', issues: err.issues })
      // 0.4.0: rejection due to protocol state (deficit, fund, oracle): 409 with a code
      if (err instanceof ProtocolStateError)
        return reply.status(err.status).send({ error: err.message, code: err.code })
      if (err instanceof CommandError) return reply.status(422).send({ error: err.message })
      if (err instanceof ClaimError)
        return reply.status(err.status).send({ error: err.message, code: err.code })
      if (err instanceof EvmSignatureError)
        return reply.status(401).send({ error: err.message, code: 'EVM_SIGNATURE' })
      if (err instanceof LoopSignatureError)
        return reply.status(401).send({ error: err.message, code: 'LOOP_SIGNATURE' })
      if (err instanceof LoopKeyError)
        return reply.status(400).send({ error: err.message, code: 'LOOP_KEY' })
      if (err instanceof LoopError)
        return reply.status(err.status).send({ error: err.message, code: err.code })
      // A-8: the ledger did not respond; this is not a contract rejection; the client will retry
      if (err instanceof LedgerUnavailableError) {
        req.log.warn({ err: err.message }, 'ledger unavailable')
        return reply.status(503).send({ error: err.publicText })
      }
      if (err instanceof RegistryError) {
        req.log.warn({ err: err.message }, 'token registry failed')
        return reply.status(503).send({ error: 'The token registry is unavailable, try again' })
      }
      if (err instanceof SigningForbiddenError)
        return reply.status(403).send({ error: 'the backend does not sign for this party' })
      if (err instanceof NoCredentialError) {
        req.log.error({ err: err.message }, 'no ledger credential')
        return reply.status(503).send({ error: 'service unavailable' })
      }
      if (err instanceof LedgerError) {
        req.log.warn({ err: err.message }, 'ledger rejected')
        const known = explainRejection(err.publicText)
        if (known)
          return reply.status(known.status).send({ error: known.message, code: known.code })
        return reply.status(422).send({ error: err.publicText })
      }
      if ((err as { statusCode?: number }).statusCode === 429)
        return reply.status(429).send({ error: 'too many requests' })
      req.log.error(err)
      return reply.status(500).send({ error: 'internal error' })
    })

    /**
     * Session token: the X-Session-Token header, else Authorization: Bearer, else the cookie
     * `lending_session` (F-15). A separate header is needed behind nginx basic auth: the browser
     * sends the demo password in Authorization, and a Bearer in the same header would replace it.
     */
    function tokenOf(req: FastifyRequest): string | undefined {
      return headerToken(req) ?? cookieToken(req)
    }

    // F-15: CSRF: non-GET with a cookie only with X-Lending-Client: web and an allowed Origin
    const origins = new Set(deps.allowedOrigins ?? [])
    app.addHook('onRequest', async (req, reply) => {
      const why = csrfViolation(req, origins)
      if (why) {
        req.log.warn({ why }, 'csrf check failed')
        return reply.status(403).send({ error: 'cross-site request refused', code: 'CSRF' })
      }
    })

    /** Session party, or null. */
    function sessionOf(req: FastifyRequest): string | null {
      return auth.verify(tokenOf(req)) ?? null
    }

    /** Session required; the token's party must match the request's party (audit V1). */
    function requireParty(req: FastifyRequest, reply: FastifyReply, expected: string): boolean {
      const sessionParty = auth.verify(tokenOf(req))
      if (!sessionParty) {
        void reply.status(401).send({ error: 'sign in with your wallet first' })
        return false
      }
      if (sessionParty !== expected) {
        void reply.status(403).send({ error: 'this session belongs to another party' })
        return false
      }
      req.party = sessionParty
      return true
    }

    const sealed = (p: PreparedCommand) => ({ ...p, seal: auth.sealCommand(p) })

    const partyLimit = deps.commandRatePerPartyPerMinute
      ? createPartyRateLimiter(deps.commandRatePerPartyPerMinute)
      : null
    /** Command: a session of this party and the per-party preparation limit (D-7). */
    function requireCommandParty(req: FastifyRequest, reply: FastifyReply, expected: string) {
      if (!requireParty(req, reply, expected)) return false
      const wait = partyLimit?.take(expected) ?? 0
      if (wait > 0) {
        void reply
          .status(429)
          .header('retry-after', String(wait))
          .send({
            error: `Too many operations from this account, try again in ${wait} s`,
            code: 'PARTY_RATE_LIMITED',
          })
        return false
      }
      return true
    }

    /**
     * Pool synchronizer: from the config or from the ACS (the Pool contract carries its
     * synchronizerId).
     */
    let synchronizerId = deps.network?.synchronizerId ?? null
    /** Deployment markets. */
    const deployedMarkets = marketsOf(d)

    app.get('/config', async (): Promise<AppConfig> => {
      // §4: roles from ProtocolConfig, re-read; without the ledger, the last known ones
      const r = await reader.roles()
      if (!synchronizerId)
        synchronizerId = await reader
          .cachedSnapshot()
          .then((s) => s.pool.synchronizerId || null)
          .catch(() => null)
      return {
        instruments: {
          usdcx: d.usdcx,
          cc: d.cc,
          cbtc: d.cbtc,
        },
        markets: deployedMarkets,
        roles: {
          operator: r.operator,
          guardian: r.guardian,
          treasury: r.treasury,
          liquidator: r.liquidators.includes(d.liquidator)
            ? d.liquidator
            : (r.liquidators[0] ?? d.liquidator),
          backstop: r.backstop,
          liquidators: r.liquidators,
        },
        testFaucet: !!deps.testFaucet,
        networkId: deps.networkId,
        network: {
          name: deps.network?.name ?? 'devnet',
          networkId: deps.networkId,
          synchronizerId,
        },
        // EVM_WALLETS disabled: no key at all
        ...(evm ? { evm: { network: evmNetwork, custody: evm.custody! } } : {}),
        // The key is present when the process knows about Loop (app.ts always passes it); enabled
        // says whether it is on
        ...(deps.loop ? { loop: loopConfig } : {}),
        // Real profile only: on DevNet there is no key at all, the response is unchanged
        ...(deps.realAssets ? { realAssets: deps.realAssets.info } : {}),
      }
    })

    // Public snapshot: cached for seconds, one ledger request for everyone (B-4)
    app.get('/pool', async () => poolView(d, await reader.cachedSnapshot(), new Date()))

    // Login ---------------------------------------------------------------------

    app.post('/auth/challenge', async (req) => {
      const b = z.object({ party }).parse(req.body)
      const nonce = auth.challenge(b.party)
      // Login expiry equals the nonce expiry: abandoned logins are cleaned up by the logins bot
      // (M5)
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
      return { nonce, command: sealed(await commands.login(b.party, nonce, expiresAt)) }
    })

    app.post('/auth/login', async (req, reply) => {
      const b = z.object({ party, nonce: z.string().regex(/^[0-9a-f]{60}$/) }).parse(req.body)
      // The nonce is checked by the server signature, no shared map (M1); single use: Login_Consume
      if (!auth.checkChallenge(b.party, b.nonce))
        return reply.status(401).send({ error: 'login contract not found or expired' })
      // §2: a Login without an expiry or beyond the cap is not accepted; Login_Reap cleans them up
      const now = Date.now()
      const login = (await reader.logins()).find(
        (l) =>
          l.payload.user === b.party &&
          l.payload.nonce === b.nonce &&
          l.payload.operator === d.operator &&
          acceptableLogin(l.payload.expiresAt, now),
      )
      if (!login) return reply.status(401).send({ error: 'login contract not found or expired' })
      await ledger.submit(
        [d.operator],
        [
          {
            ExerciseCommand: {
              templateId: TEMPLATES.login,
              contractId: login.contractId,
              choice: 'Login_Consume',
              choiceArgument: {},
            },
          },
        ],
      )
      const token = auth.issue(b.party)
      // F-15: the browser gets the session in an httpOnly cookie; the token in the body is for API
      // clients
      setSessionCookie(req, reply, token, auth.ttlMs)
      return { token }
    })

    // EVM wallet login (0.5.0, ADR-004) ---------------------------------------------
    // Message like Sign-In with Ethereum: domain, address, chain, one-time nonce and expiry.
    // The signature is checked here (ecrecover), single use via the nonce journal. Operations are
    // then each signed and verified by the contract.

    const evm = deps.evm?.enabled ? deps.evm : null
    const evmNetwork = deps.networkId ?? 'canton'
    const loginText = (host: string, address: string, nonce: string) => {
      const exp = parseInt(nonce.slice(0, 12), 16)
      return evm!.loginMessage({
        host,
        address,
        network: evmNetwork,
        nonce,
        issuedAt: new Date(exp - CHALLENGE_TTL_MS).toISOString(),
        expiresAt: new Date(exp).toISOString(),
      })
    }

    /** Pool operations shared by custodial accounts (EVM and Loop). */
    // all: the whole deposit or debt; it travels as the amount "max" to the builders
    // `full` is accepted as the same flag: the frontend sends Loop and EVM operations with the
    // EvmAction field name
    const poolOps = [
      z.object({ op: z.literal('supply'), amount, all, full: all }),
      z.object({ op: z.literal('repay'), amount, all, full: all }),
      z.object({ op: z.literal('withdraw'), amount, all, full: all }),
      z.object({ op: z.literal('borrow'), amount }),
      z.object({ op: z.literal('deposit-collateral'), marketId, amount }),
      z.object({ op: z.literal('withdraw-collateral'), marketId, amount }),
    ] as const
    /** The pool op of a request: `all` becomes the amount "max". */
    const poolOpOf = <
      T extends {
        op: string
        amount: string
        all?: boolean | undefined
        full?: boolean | undefined
      },
    >(
      b: T,
    ) => ({ ...b, amount: b.all || b.full ? 'max' : b.amount }) as T
    const instruments = instrumentsOf(d)

    if (evm) {
      app.post('/auth/evm/challenge', async (req) => {
        const b = z.object({ address: evmAddress }).parse(req.body)
        const nonce = auth.challenge(`evm:${b.address}`)
        return { nonce, message: loginText(req.host, b.address, nonce) }
      })

      app.post('/auth/evm/login', async (req, reply) => {
        const b = z
          .object({
            address: evmAddress,
            nonce: z.string().regex(/^[0-9a-f]{60}$/),
            signature: evmSignature,
          })
          .parse(req.body)
        if (!auth.checkChallenge(`evm:${b.address}`, b.nonce))
          return reply.status(401).send({ error: 'sign-in request expired, try again' })
        const signer = await evmSigner(loginText(req.host, b.address, b.nonce), b.signature)
        if (signer !== b.address)
          return reply.status(401).send({ error: 'the signature is from another wallet' })
        if (!auth.useOnce(`evm-login:${b.nonce}`, parseInt(b.nonce.slice(0, 12), 16)))
          return reply.status(401).send({ error: 'this sign-in was already used, try again' })
        // The account is opened on first login: an empty account does nothing without a signature
        await evm.ensureAccount(b.address)
        const token = auth.issue(b.address)
        setSessionCookie(req, reply, token, auth.ttlMs)
        return { token }
      })

      // Real asset withdrawals (0.6.0): only with the real profile, otherwise the op is unknown
      // (400)
      const walletOps = [
        z.object({
          op: z.literal('transfer-out'),
          symbol: z.enum(['USDCx', 'CC', 'CBTC']),
          amount: decimal,
          receiver: party,
        }),
        z.object({ op: z.literal('redeem'), amount: decimal, ethAddress: evmAddress }),
      ] as const
      const evmOp = deps.realAssets
        ? z.discriminatedUnion('op', [...poolOps, ...walletOps])
        : z.discriminatedUnion('op', [...poolOps])

      /** Build the operation: the sealed command and the text the wallet will sign. */
      app.post('/evm/prepare', async (req, reply) => {
        const b = z.object({ address: evmAddress }).and(evmOp).parse(req.body)
        if ('marketId' in b && !deployedMarkets.includes(b.marketId))
          return reply.status(400).send({ error: `unknown market ${b.marketId}` })
        if (!requireCommandParty(req, reply, b.address)) return reply
        if (b.op === 'transfer-out' || b.op === 'redeem') {
          const instrument = b.op === 'transfer-out' ? instruments[b.symbol] : undefined
          if (b.op === 'transfer-out' && !instrument)
            return reply.status(400).send({ error: `unknown token ${b.symbol}` })
          const p = await evm.prepareWalletOp(
            b.address,
            b.op === 'transfer-out'
              ? {
                  op: 'transfer-out',
                  instrument: instrument!,
                  amount: b.amount,
                  receiver: b.receiver,
                }
              : { op: 'redeem', amount: b.amount, ethAddress: b.ethAddress },
          )
          const body = { ...p.prepared, evm: p.evm }
          return {
            ...body,
            seal: auth.sealCommand(body),
            message: p.message,
            // redeem: the amount is rounded down to 6 decimals; the user sees the exact one
            ...(p.requestedAmount ? { requestedAmount: p.requestedAmount } : {}),
          }
        }
        const p = await evm.prepare(b.address, poolOpOf(b))
        const body = { ...p.prepared, evm: p.evm }
        return { ...body, seal: auth.sealCommand(body), message: p.message }
      })

      const claims = deps.realAssets?.claims
      if (claims)
        /**
         * USDC deposit into xReserve from MetaMask → USDCx in the address's wallet. The session is
         * the address that sent the tx; the backend itself checks the tx on Ethereum and the
         * DepositAttestation.
         */
        app.post('/evm/claim-deposit', async (req, reply) => {
          const b = z
            .object({
              txHash: z
                .string()
                .regex(/^0x[0-9a-fA-F]{64}$/, 'txHash: 0x and 64 hex')
                .transform((v) => v.toLowerCase()),
            })
            .parse(req.body)
          const me = sessionOf(req)
          if (!me || !isEvmAddress(me))
            return reply.status(401).send({ error: 'sign in with your EVM wallet first' })
          if (!requireCommandParty(req, reply, me)) return reply
          const r = await claims.claim(me, b.txHash)
          const body: ClaimDepositResponse = r
          return reply.status(r.status === 'credited' ? 200 : 202).send(body)
        })

      const evmFields = z.object({
        network: z.string(),
        operator: z.string(),
        address: evmAddress,
        action: z.record(z.string(), z.unknown()),
        debt: z.string(),
        nonce: z.number().int().min(0),
        expiresAt: z.string(),
      })
      /** Submit the signed operation as the custodian; the contract verifies the signature. */
      app.post('/evm/submit', async (req, reply) => {
        const b = z
          .object({
            actAs: z.array(z.string()).length(1),
            commands: z.array(z.unknown()).length(1),
            disclosedContracts: z.array(z.unknown()),
            evm: evmFields,
            seal: z.string(),
            signature: evmSignature,
          })
          .parse(req.body)
        const { seal, signature, ...body } = b
        if (!requireParty(req, reply, body.evm.address)) return reply
        const verdict = auth.checkSeal(body, seal)
        if (verdict === 'invalid')
          return reply.status(403).send({ error: 'command was not prepared by this server' })
        if (verdict !== 'ok')
          return reply.status(422).send({
            error: `STALE_CONTRACT: command ${verdict === 'reused' ? 'already submitted' : 'expired'}, prepare it again`,
          })
        return evm.submit(body as unknown as SealedBody, signature)
      })
    }

    // Loop wallet login (0.7.0) ---------------------------------------------------
    // Loop signs with Ed25519 (`provider.signMessage`); Daml cannot verify such a signature,
    // so the backend verifies it: the key yields the fingerprint from the party ID, the signature
    // is by that key.
    // Login single use: the nonce journal (useOnce); operations: the LoopWallet nonce and the seal.

    const loop = deps.loop?.enabled ? deps.loop : null
    const loopConfig: LoopConfig = {
      enabled: !!loop,
      network: deps.network?.name ?? 'devnet',
      appName: deps.loopAppName ?? 'Canton Lending',
      custody: loop?.custody ?? null,
    }
    /**
     * Challenge subject: the party and the canonical key, so the nonce does not carry over to
     * another key.
     */
    const loopChallengeOf = (p: string, key: string) => `${loopSubject(p)}|${key}`
    const loopLoginText = (host: string, p: string, key: string, nonce: string) => {
      const exp = parseInt(nonce.slice(0, 12), 16)
      return loopLoginMessage({
        host,
        party: p,
        publicKey: key,
        network: evmNetwork,
        nonce,
        issuedAt: new Date(exp - CHALLENGE_TTL_MS).toISOString(),
        expiresAt: new Date(exp).toISOString(),
      })
    }

    if (loop) {
      app.post('/auth/loop/challenge', async (req, reply) => {
        const b = z.object({ party: loopParty, publicKey: z.string().max(512) }).parse(req.body)
        const key = parseLoopPublicKey(b.publicKey)
        if (!bindsParty(key, b.party))
          return reply.status(401).send({
            error: 'this public key does not belong to the party',
            code: 'LOOP_KEY_MISMATCH',
          })
        const nonce = auth.challenge(loopChallengeOf(b.party, key.canonical))
        return {
          nonce,
          publicKey: key.canonical,
          message: loopLoginText(req.host, b.party, key.canonical, nonce),
        }
      })

      app.post('/auth/loop/login', async (req, reply) => {
        const b = z
          .object({
            party: loopParty,
            publicKey: z.string().max(512),
            message: z.string().max(2_000),
            signature: loopSignature,
            nonce: z
              .string()
              .regex(/^[0-9a-f]{60}$/)
              .optional(),
          })
          .parse(req.body)
        const key = parseLoopPublicKey(b.publicKey)
        // The signMessage response format is undocumented: log its shape (without values)
        req.log.info(
          {
            loopSignature: shapeOf(b.signature),
            loopPublicKey: { kind: key.kind, encoding: key.encoding, format: key.format },
          },
          'loop login payload',
        )
        const binding = bindsParty(key, b.party)
        if (!binding)
          return reply.status(401).send({
            error: 'this public key does not belong to the party',
            code: 'LOOP_KEY_MISMATCH',
          })
        const nonce = b.nonce ?? loopLoginNonce(b.message)
        if (!nonce || !auth.checkChallenge(loopChallengeOf(b.party, key.canonical), nonce))
          return reply.status(401).send({ error: 'sign-in request expired, try again' })
        const expected = loopLoginText(req.host, b.party, key.canonical, nonce)
        if (b.message !== expected)
          return reply.status(401).send({ error: 'the sign-in message was not issued here' })
        const sig = extractSignature(b.signature)
        const match = sig ? verifyLoopSignature(key, expected, sig) : null
        if (!match) {
          req.log.warn({ loopSignature: shapeOf(b.signature) }, 'loop login signature rejected')
          return reply
            .status(401)
            .send({ error: 'the signature does not match the key', code: 'LOOP_SIGNATURE' })
        }
        req.log.info({ loopSignatureMatch: { ...match, binding } }, 'loop login signature ok')
        // After the signature check: someone else's request will not burn the nonce. The insert is
        // atomic (SQLite)
        if (!auth.useOnce(`loop-login:${nonce}`, parseInt(nonce.slice(0, 12), 16)))
          return reply.status(401).send({ error: 'this sign-in was already used, try again' })
        await loop.ensureAccount(b.party, key.canonical)
        const token = auth.issue(loopSubject(b.party))
        setSessionCookie(req, reply, token, auth.ttlMs)
        return { token, party: loopSubject(b.party) }
      })

      const loopOp = z.discriminatedUnion('op', [
        ...poolOps,
        z.object({
          op: z.literal('transfer-out'),
          symbol: z.enum(['USDCx', ...MARKETS]),
          amount: decimal,
          receiver: party,
        }),
      ])

      /** Build the operation: the sealed command and the text Loop will sign. */
      app.post('/loop/prepare', async (req, reply) => {
        const b = z.object({ party: loopParty }).and(loopOp).parse(req.body)
        if ('marketId' in b && !deployedMarkets.includes(b.marketId))
          return reply.status(400).send({ error: `unknown market ${b.marketId}` })
        if (!requireCommandParty(req, reply, loopSubject(b.party))) return reply
        let p
        if (b.op === 'transfer-out') {
          const instrument = instruments[b.symbol]
          if (!instrument) return reply.status(400).send({ error: `unknown token ${b.symbol}` })
          p = await loop.prepare(b.party, {
            op: 'transfer-out',
            instrument,
            amount: b.amount,
            receiver: b.receiver,
          })
        } else p = await loop.prepare(b.party, poolOpOf(b))
        const body = { ...p.prepared, loop: p.loop }
        return { ...body, seal: auth.sealCommand(body), message: p.message }
      })

      const loopFields = z.object({
        network: z.string(),
        operator: z.string(),
        party: loopParty,
        action: z.record(z.string(), z.unknown()),
        debt: z.string(),
        nonce: z.number().int().min(0),
        expiresAt: z.string(),
      })
      /** Submit the signed operation as the custodian: the backend verifies the signature. */
      app.post('/loop/submit', async (req, reply) => {
        const b = z
          .object({
            actAs: z.array(z.string()).length(1),
            commands: z.array(z.unknown()).length(1),
            disclosedContracts: z.array(z.unknown()),
            loop: loopFields,
            seal: z.string(),
            signature: loopSignature,
          })
          .parse(req.body)
        const { seal, signature, ...body } = b
        if (!requireParty(req, reply, loopSubject(body.loop.party))) return reply
        const verdict = auth.checkSeal(body, seal)
        if (verdict === 'invalid')
          return reply.status(403).send({ error: 'command was not prepared by this server' })
        if (verdict !== 'ok')
          return reply.status(422).send({
            error: `STALE_CONTRACT: command ${verdict === 'reused' ? 'already submitted' : 'expired'}, prepare it again`,
          })
        req.log.info({ loopSignature: shapeOf(signature) }, 'loop operation payload')
        const sig = extractSignature(signature)
        if (!sig)
          return reply
            .status(401)
            .send({ error: 'no signature in the request', code: 'LOOP_SIGNATURE' })
        const r = await loop.submit(body as unknown as LoopSealedBody, sig)
        req.log.info({ loopSignatureMatch: r.match }, 'loop operation signature ok')
        return { updateId: r.updateId }
      })
    }

    /**
     * Session by cookie or token (F-15): the frontend restores the login without storing the token.
     */
    app.get('/auth/session', async (req, reply) => {
      const s = auth.session(tokenOf(req))
      if (!s) return reply.status(401).send({ error: 'no session' })
      return { party: s.party, expiresAt: new Date(s.expiresAt).toISOString() }
    })

    /**
     * Logout (B-18): the session token is revoked before its expiry, the cookie is cleared (F-15).
     */
    app.post('/auth/logout', async (req, reply) => {
      const revoked = auth.revoke(tokenOf(req))
      clearSessionCookie(req, reply)
      return { revoked }
    })

    // User data: own party only --------------------------------------

    /**
     * Whose account is in the path: a Loop session of this party (`loop:<party>`) views the Loop
     * account, not the Canton party account with the same ID. Otherwise, as in the path.
     */
    const ownerOf = (req: FastifyRequest, p: string) =>
      loop && sessionOf(req) === loopSubject(p) ? loopSubject(p) : p

    app.get<{ Params: { party: string } }>('/accounts/:party', async (req, reply) => {
      const owner = ownerOf(req, req.params.party)
      if (!requireParty(req, reply, owner)) return reply
      const [snapshot, account] = await Promise.all([
        reader.cachedSnapshot(),
        reader.cachedAccount(owner),
      ])
      const body: AccountResponse = { account: accountView(d, snapshot, account, new Date()) }
      return body
    })

    // Free holdings of the party per protocol instrument: one ACS read (F-16)
    const balances = (owner: string): Promise<WalletBalances> => reader.walletBalances(owner)

    // Loop (0.7.0): /wallet/<party> with a Loop session and /wallet/loop:<party> are LoopWallet
    // shares
    app.get<{ Params: { party: string } }>('/wallet/:party', async (req, reply) => {
      const owner = ownerOf(req, req.params.party)
      if (!requireParty(req, reply, owner)) return reply
      return balances(owner)
    })

    // Buyers of absorbed collateral (K5): the stock per asset, the discount and the price. The view
    // has no account and no party: the protocol absorbed the positions, the buyer only buys (§9)
    const asBuyer = async (req: FastifyRequest, reply: FastifyReply, me: string) => {
      const roles = await reader.roles()
      if (!roles.liquidators.includes(me) && me !== roles.backstop) {
        reply.status(403).send({ error: 'only an approved buyer: a liquidator or the backstop' })
        return null
      }
      if (!requireParty(req, reply, me)) return null
      return roles
    }
    app.get<{ Params: { party: string } }>('/buyer/:party', async (req, reply) => {
      const me = req.params.party
      const roles = await asBuyer(req, reply, me)
      if (!roles) return reply
      const [s, wallet] = await Promise.all([reader.cachedSnapshot(), balances(me)])
      const now = new Date()
      const n = poolNumbers(s, now)
      const view: BuyerView = {
        role: me === roles.backstop ? 'backstop' : 'liquidator',
        forSale: n.reserves.lt(s.config.payload.params.targetReserves),
        reserves: n.reserves.toFixed(10),
        targetReserves: dec(s.config.payload.params.targetReserves).toFixed(10),
        buyPaused: s.pause.payload.flags.buyPaused,
        collateral: MARKETS.map((m) => saleView(s, d, m, now)).filter((x) => x !== null),
        wallet,
      }
      return view
    })

    app.post('/buyer/quote', async (req, reply) => {
      const b = z.object({ party, marketId, amount: decimal }).parse(req.body)
      if (!(await asBuyer(req, reply, b.party))) return reply
      const s = await reader.cachedSnapshot()
      const sale = saleView(s, d, b.marketId, new Date())
      const out = sale ? quoteCollateral(sale, b.amount) : null
      if (!sale?.price || !out)
        return reply.status(409).send({ error: 'No usable price for this asset now' })
      const quote: CollateralQuote = {
        marketId: b.marketId,
        pay: dec(b.amount).toFixed(10),
        receive: out,
        minReceive: money(dec(out).mul(dec(1).minus(deps.buyTolerance ?? '0.02'))),
        price: sale.price,
      }
      return quote
    })

    app.post('/buyer/prepare', async (req, reply) => {
      const b = z
        .object({
          party,
          marketId,
          amount: decimal,
          minCollateral: decimal,
          inputHoldingCids: holdings,
        })
        .parse(req.body)
      if (!(await asBuyer(req, reply, b.party))) return reply
      if (!requireCommandParty(req, reply, b.party)) return reply
      return sealed(
        await commands.buyCollateral(
          b.party,
          b.marketId,
          b.amount,
          b.minCollateral,
          b.inputHoldingCids,
        ),
      )
    })

    // Reserves (K6): viewed by treasury and guardian, added by treasury
    app.get('/treasury', async (req, reply) => {
      const me = sessionOf(req)
      const roles = await reader.roles()
      if (!me || (me !== roles.treasury && me !== roles.guardian))
        return reply.status(403).send({ error: 'only the treasury or the guardian' })
      const [s, treasuryWallet, backstopWallet] = await Promise.all([
        reader.cachedSnapshot(),
        balances(roles.treasury),
        balances(roles.backstop),
      ])
      const n = poolNumbers(s, new Date())
      const view: TreasuryView = {
        reserves: n.reserves.toFixed(10),
        netReserves: n.netReserves.toFixed(10),
        targetReserves: dec(s.config.payload.params.targetReserves).toFixed(10),
        cash: n.cash.toFixed(10),
        treasuryUsdcx: treasuryWallet.USDCx,
        backstopUsdcx: backstopWallet.USDCx,
        collateralBook: MARKETS.filter((m) => s.markets.has(m)).map((marketId) => {
          const m = s.markets.get(marketId)
          return {
            marketId,
            amount: dec(m?.protocolCollateral ?? '0').toFixed(10),
            basis: dec(m?.protocolCollateralBasis ?? '0').toFixed(10),
          }
        }),
      }
      return view
    })

    app.post('/treasury/add-reserves', async (req, reply) => {
      const treasury = (await reader.roles()).treasury
      if (!requireCommandParty(req, reply, treasury)) return reply
      const b = z
        .object({ amount: z.string().regex(/^\d+(\.\d{1,10})?$/), inputHoldingCids: holdings })
        .parse(req.body)
      if (dec(b.amount).lte(0)) throw new CommandError('Enter an amount above zero')
      return sealed(await commands.addReserves(treasury, b.amount, b.inputHoldingCids))
    })

    app.get<{ Params: { party: string } }>('/history/:party', async (req, reply) => {
      const owner = ownerOf(req, req.params.party)
      if (!requireParty(req, reply, owner)) return reply
      const body: HistoryResponse = { operations: deps.history(owner) }
      return body
    })

    const previewBody = z.object({
      party: subject,
      op: z.enum([
        'supply',
        'repay',
        'withdraw',
        'borrow',
        'deposit-collateral',
        'withdraw-collateral',
      ]),
      amount,
      /** all: the whole deposit, debt or asset collateral; the same as the amount "max" */
      all,
      marketId: marketId.optional(),
      /** Wallet holding totals (Loop): the backend cannot see them, the frontend does not sum. */
      walletAmounts: amounts,
    })
    app.post('/preview', async (req, reply) => {
      const b = previewBody.parse(req.body)
      if (b.marketId && !deployedMarkets.includes(b.marketId))
        return reply.status(400).send({ error: `unknown market ${b.marketId}` })
      if (!requireParty(req, reply, b.party)) return reply
      const [snapshot, account] = await Promise.all([
        reader.cachedSnapshot(),
        reader.cachedAccount(b.party),
      ])
      let wallet = b.walletAmounts ? b.walletAmounts.reduce((s, a) => s.plus(a), dec(0)) : null
      if (!wallet && (isEvmAddress(b.party) || isLoopSubject(b.party))) {
        // EVM wallet and Loop: the account's share of the custodian's holdings
        // (EvmWallet/LoopWallet.balances)
        const balances = await reader.walletBalances(b.party)
        wallet = dec(
          b.op === 'deposit-collateral' && b.marketId ? balances[b.marketId] : balances.USDCx,
        )
      }
      return preview(
        d,
        snapshot,
        account?.payload ?? null,
        b.op,
        b.all ? 'max' : b.amount,
        b.marketId,
        new Date(),
        wallet,
      )
    })

    const handlers: { [K in Op]: (b: z.infer<(typeof bodies)[K]>) => Promise<PreparedCommand> } = {
      'open-account': (b) => commands.openAccount(b.party),
      supply: (b) => commands.supply(b.party, b.amount, b.inputHoldingCids, b.all === true),
      repay: (b) => commands.repay(b.party, b.amount, b.inputHoldingCids, b.all === true),
      withdraw: (b) => commands.withdraw(b.party, b.amount, b.all === true),
      borrow: (b) => commands.borrow(b.party, b.amount),
      'deposit-collateral': (b) =>
        commands.depositCollateral(b.party, b.marketId, b.amount, b.inputHoldingCids),
      'withdraw-collateral': (b) => commands.withdrawCollateral(b.party, b.marketId, b.amount),
    }

    app.post<{ Params: { op: string } }>('/commands/:op', async (req, reply) => {
      const op = req.params.op
      // hasOwn: names from Object.prototype are not treated as commands (audit N1)
      if (!Object.hasOwn(bodies, op))
        return reply.status(404).send({ error: `unknown command ${op}` })
      const key = op as Op
      const b = bodies[key].parse(req.body) as { party: string; marketId?: MarketId }
      if (b.marketId && !deployedMarkets.includes(b.marketId))
        return reply.status(400).send({ error: `unknown market ${b.marketId}` })
      if (!requireCommandParty(req, reply, b.party)) return reply
      const handler = handlers[key] as (b: unknown) => Promise<PreparedCommand>
      return sealed(await handler(b))
    })

    // Council (0.4.0) ------------------------------------------------------------------
    // The backend only builds the command for the wallet of a council member or treasury (D-5, N4).
    // Proposal_ExecuteTrusted and council formation belong to the operator (scripts/governance.ts).

    if (deps.governance) {
      const gov = deps.governance
      const cid = z.string().min(1).max(512)
      const expiresAt = z.iso.datetime({ offset: true }).transform((v) => new Date(v))
      const rolesBody = z.object({
        operator: party,
        oracle: party,
        guardian: party,
        treasury: party,
        backstop: party,
        liquidators: z.array(party).min(1).max(20),
      })
      const decimalPatch = z.record(z.string(), z.string().regex(/^\d{1,18}(\.\d{1,18})?$/))
      const ACTIONS = {
        proposals: ['approve', 'execute', 'withdraw'],
        rotations: ['approve', 'join', 'execute', 'withdraw'],
        income: ['approve', 'execute', 'withdraw'],
      } as const
      type Kind = keyof typeof ACTIONS

      app.get('/governance', async (req, reply) => {
        const me = sessionOf(req)
        if (!me) return reply.status(401).send({ error: 'sign in with your wallet first' })
        const view = await gov.view()
        const allowed =
          view.council?.members.includes(me) ||
          me === view.roles.treasury ||
          me === view.roles.operator ||
          view.rotations.some((r) => r.newMembers.includes(me)) ||
          // members of the Decentralized Party's GovernanceRules see the council it runs
          !!view.decman?.members.includes(me)
        if (!allowed)
          return reply.status(403).send({ error: 'only council members and the treasury' })
        return view
      })

      app.post('/governance/proposals', async (req, reply) => {
        const b = z
          .object({
            party,
            proposalId: z.string().min(1).max(100),
            description: z.string().max(1000).default(''),
            expiresAt,
            newRoles: rolesBody.optional(),
            /** ProtocolParams changes: top-level decimal fields only */
            paramsPatch: decimalPatch.optional(),
            /** MarketParams changes per market: {CC: {borrowCollateralFactor: "0.25"}} */
            marketParamsPatch: z.partialRecord(marketId, decimalPatch).optional(),
          })
          .parse(req.body)
        if (!requireCommandParty(req, reply, b.party)) return reply
        const s = await reader.snapshot()
        const cfg = s.config.payload
        const newParams = b.paramsPatch ? applyParamsPatch(cfg.params, b.paramsPatch) : undefined
        const newMarketParams = b.marketParamsPatch
          ? cfg.marketParams.map(([id, mp]): [string, typeof mp] => {
              const patch = b.marketParamsPatch?.[id as MarketId]
              if (!patch) return [id, mp]
              for (const k of Object.keys(patch))
                if (typeof (mp as unknown as Record<string, unknown>)[k] !== 'string')
                  throw new CommandError(`Unknown market parameter ${k}`)
              return [id, { ...mp, ...patch }]
            })
          : undefined
        return sealed(
          await gov.proposeParams(b.party, {
            proposalId: b.proposalId,
            description: b.description,
            expiresAt: b.expiresAt,
            ...(newParams ? { newParams } : {}),
            ...(newMarketParams ? { newMarketParams } : {}),
            ...(b.newRoles ? { newRoles: b.newRoles } : {}),
          }),
        )
      })

      app.post('/governance/rotations', async (req, reply) => {
        const b = z
          .object({
            party,
            rotationId: z.string().min(1).max(100),
            newMembers: z.array(party).min(1).max(20),
            newThreshold: z.number().int().min(1),
            expiresAt,
          })
          .parse(req.body)
        if (!requireCommandParty(req, reply, b.party)) return reply
        return sealed(await gov.proposeRotation(b.party, b))
      })

      app.post('/governance/income', async (req, reply) => {
        const b = z
          .object({
            party,
            proposalId: z.string().min(1).max(100),
            reservesAmount: decimal,
            expiresAt,
          })
          .parse(req.body)
        if (!requireCommandParty(req, reply, b.party)) return reply
        return sealed(await gov.proposeIncome(b.party, b))
      })

      app.post<{ Params: { kind: string; cid: string; action: string } }>(
        '/governance/:kind/:cid/:action',
        async (req, reply) => {
          const { kind, action } = req.params
          if (
            !Object.hasOwn(ACTIONS, kind) ||
            !(ACTIONS[kind as Kind] as readonly string[]).includes(action)
          )
            return reply.status(404).send({ error: `unknown governance action ${kind}/${action}` })
          const target = cid.parse(req.params.cid)
          const b = z.object({ party }).parse(req.body)
          if (!requireCommandParty(req, reply, b.party)) return reply
          const run: Record<string, (p: string, c: string) => Promise<PreparedCommand>> = {
            'proposals/approve': gov.approveProposal,
            'proposals/execute': gov.executeProposal,
            'proposals/withdraw': gov.withdrawProposal,
            'rotations/approve': gov.approveRotation,
            'rotations/join': gov.joinRotation,
            'rotations/execute': gov.executeRotation,
            'rotations/withdraw': gov.withdrawRotation,
            'income/approve': gov.approveIncome,
            'income/execute': gov.executeIncome,
            'income/withdraw': gov.withdrawIncome,
          }
          return sealed(await run[`${kind}/${action}`]!(b.party, target))
        },
      )
    }

    // Guardian --------------------------------------------------------------------

    // Five pause flags in PauseState (K7): the guardian replaces them without touching the pool
    app.post('/admin/pause', async (req, reply) => {
      const b = z
        .object({
          party: party.optional(),
          flag: z.enum([
            'borrowPaused',
            'collateralWithdrawPaused',
            'supplyWithdrawPaused',
            'absorbPaused',
            'buyPaused',
          ]),
          paused: z.boolean(),
        })
        .parse(req.body)
      if (!requireCommandParty(req, reply, (await reader.roles()).guardian)) return reply
      return sealed(await commands.setPause(b.flag, b.paused))
    })

    if (deps.testFaucet) {
      // Faucet for any logged-in party (DevNet): the registry cannot mint a token to another party,
      // since Token is also signed by the owner. So the registry (admin) creates a transfer
      // offer TokenTransferOffer, and the user accepts it with their wallet.
      const limiter = createFaucetLimiter()
      // Portion per request: about $10,000 at demo prices, enough for collateral and a borrow
      const PORTION = faucetPortions(d)
      app.post('/faucet', async (req, reply) => {
        const owner = sessionOf(req)
        if (!owner) return reply.status(401).send({ error: 'sign in to get test tokens' })
        const b = z.object({ symbol: z.enum(['USDCx', ...MARKETS]) }).parse(req.body)
        const portion = PORTION[b.symbol]
        if (!portion) return reply.status(404).send({ error: `no ${b.symbol} market here` })
        const verdict = limiter.take(owner, b.symbol, req.ip)
        if (!verdict.ok)
          return reply
            .status(429)
            .header('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)))
            .send({ error: verdict.reason })
        const [amount, instrumentId] = portion
        // EVM wallet and Loop: the custodian receives the tokens and immediately credits them to
        // the account's wallet
        const evmOwner = isEvmAddress(owner)
        if (evmOwner && !evm) return reply.status(404).send({ error: 'EVM wallets are off' })
        const loopOwner = loopPartyOf(owner)
        if (loopOwner && !loop) return reply.status(404).send({ error: 'Loop wallets are off' })
        const receiver = evmOwner ? evm!.custody! : loopOwner ? loop!.custody! : owner
        const now = new Date()
        const r = await ledger.submit(
          [instrumentId.admin],
          [
            {
              CreateCommand: {
                templateId: TEMPLATES.testTokenTransferOffer,
                createArguments: {
                  transfer: {
                    sender: instrumentId.admin,
                    receiver,
                    amount,
                    instrumentId,
                    requestedAt: now.toISOString(),
                    executeBefore: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
                    inputHoldingCids: [],
                    meta: { values: {} },
                  },
                },
              },
            },
          ],
          [],
          [],
          { commandId: `faucet-${randomUUID()}` },
        )
        const offerCid = r.events.find((e) =>
          e.CreatedEvent?.templateId.endsWith(
            ':Splice.Testing.Tokens.TestTokenV1:TokenTransferOffer',
          ),
        )?.CreatedEvent?.contractId
        if (!offerCid) throw new Error('faucet: the registry did not create a transfer offer')
        if (loopOwner) {
          await loop!.receive(loopOwner, offerCid)
          return { offerCid, symbol: b.symbol, amount, instrument: instrumentId, received: true }
        }
        if (evmOwner) {
          await evm!.receive(owner, offerCid)
          return { offerCid, symbol: b.symbol, amount, instrument: instrumentId, received: true }
        }
        return { offerCid, symbol: b.symbol, amount, instrument: instrumentId }
      })
    }
  }

/** Faucet portions by symbol: only this deployment's instruments. */
function faucetPortions(d: Deployment): Partial<Record<'USDCx' | MarketId, [string, Instrument]>> {
  const amounts: Record<'USDCx' | MarketId, string> = {
    USDCx: '10000',
    CC: '50000',
    CBTC: '0.2',
  }
  return Object.fromEntries(
    Object.entries(instrumentsOf(d)).map(([symbol, i]) => [
      symbol,
      [amounts[symbol as 'USDCx' | MarketId], i],
    ]),
  )
}
