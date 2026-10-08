/**
 * API sessions (audit V1): the caller's party is proven by a signature on the ledger.
 * 1. POST /auth/challenge → nonce and a command creating Login(user, operator, nonce).
 * 2. The user's wallet signs the command.
 * 3. POST /auth/login → the backend finds the Login with this nonce, consumes it and issues a
 *    token.
 * The token is HMAC-SHA256 over party and expiry, with no server-side state.
 *
 * Follow-up audit:
 * - M1, L6: the nonce is self-verifying: HMAC over party, expiry and a random part. The server does
 *   not store the challenge, so someone else's request cannot overwrite the victim's nonce, a party
 *   can have any number of open logins, and memory does not grow. Single use is enforced by the
 *   ledger: Login_Consume archives the contract, a second login with the same nonce will not find
 *   it.
 * - L6: separate keys for sessions, seals and nonces, derived from AUTH_SECRET.
 * - M5: a command seal carries the issue time and a one-time id; an expired or reused
 *   seal is rejected.
 * - B-18: session is 2 h by default (SESSION_TTL_MS), the token has a jti, POST /auth/logout
 *   revokes it. Revocations and used seals are in SQLite (sqliteAuthStore): both blue/green
 *   slots see the same thing.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lt } from 'drizzle-orm'
import type { Db } from './db/client.ts'
import { revokedSession, usedSeal } from './db/schema.ts'

export const DEFAULT_SESSION_TTL_MS = 2 * 3_600_000
export const CHALLENGE_TTL_MS = 5 * 60_000
export const SEAL_TTL_MS = 2 * 60_000
/** Memory limit for used seals: no more than this accumulates in 2 minutes under the rate limit. */
export const MAX_USED_SEALS = 20_000

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')

/** Where revoked sessions and used seals are stored. */
export interface AuthStore {
  isRevoked(jti: string): boolean
  revoke(jti: string, expiresAt: number): void
  /** 'ok': the seal is new and recorded; 'reused': already seen; 'full': no room */
  useSeal(id: string, expiresAt: number, now: number): 'ok' | 'reused' | 'full'
}

export function memoryAuthStore(): AuthStore {
  const revoked = new Map<string, number>()
  /** Used seal ids → expiry; expired ones are removed, their seal would fail anyway. */
  const usedSeals = new Map<string, number>()
  return {
    isRevoked: (jti) => revoked.has(jti),
    revoke(jti, exp) {
      revoked.set(jti, exp)
      if (revoked.size > 1_000) for (const [k, e] of revoked) if (e < Date.now()) revoked.delete(k)
    },
    useSeal(id, exp, t) {
      if (usedSeals.size >= 256) for (const [k, e] of usedSeals) if (e < t) usedSeals.delete(k)
      if (usedSeals.has(id)) return 'reused'
      // Overflow with live seals means rejection, not eviction: eviction would allow a replay
      if (usedSeals.size >= MAX_USED_SEALS) return 'full'
      usedSeals.set(id, exp)
      return 'ok'
    },
  }
}

/** Revocations and seals in SQLite: shared by processes with one database (B-18). */
export function sqliteAuthStore(db: Db): AuthStore {
  let lastSweep = 0
  const sweep = (t: number) => {
    if (t - lastSweep < 60_000) return
    lastSweep = t
    db.delete(usedSeal).where(lt(usedSeal.expiresAt, t)).run()
    db.delete(revokedSession).where(lt(revokedSession.expiresAt, t)).run()
  }
  const hasRevoked = db.sqlite.prepare('SELECT 1 FROM revoked_session WHERE jti = ?')
  const insertSeal = db.sqlite.prepare(
    'INSERT INTO used_seal (id, expires_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING',
  )
  return {
    isRevoked: (jti) => hasRevoked.get(jti) !== undefined,
    revoke(jti, exp) {
      db.insert(revokedSession).values({ jti, expiresAt: exp }).onConflictDoNothing().run()
    },
    useSeal(id, exp, t) {
      sweep(t)
      // the insert is atomic: of two concurrent checks of one seal, only one passes
      return insertSeal.run(id, exp).changes === 1 ? 'ok' : 'reused'
    },
  }
}

/** Subkey for one purpose: the session key does not sign seals and vice versa. */
const subkey = (secret: string, purpose: string) =>
  createHmac('sha256', secret).update(`canton-lending/${purpose}/v1`).digest()

export function createAuth(
  secret: string,
  now: () => number = Date.now,
  opts: { sessionTtlMs?: number; store?: AuthStore } = {},
) {
  const ttl = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const store = opts.store ?? memoryAuthStore()
  const keys = {
    session: subkey(secret, 'session'),
    seal: subkey(secret, 'seal'),
    challenge: subkey(secret, 'challenge'),
  }
  const mac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest()
  const sign = (key: Buffer, data: string) => mac(key, data).toString('base64url')
  const equal = (a: string, b: string) => {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
  }

  const decode = (token: string | undefined) => {
    if (!token) return null
    const [payload, sig] = token.split('.')
    if (!payload || !sig || !equal(sig, sign(keys.session, payload))) return null
    try {
      const p = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
        party: string
        exp: number
        jti?: string
      }
      if (!(p.exp > now())) return null
      if (p.jti && store.isRevoked(p.jti)) return null
      return p
    } catch {
      return null
    }
  }

  return {
    /** Nonce: 12 hex of expiry, 16 hex random, 32 hex HMAC(party, expiry, random). */
    challenge(party: string) {
      const exp = (now() + CHALLENGE_TTL_MS).toString(16).padStart(12, '0')
      const rand = randomBytes(8).toString('hex')
      const tag = mac(keys.challenge, `${party}|${exp}|${rand}`).subarray(0, 16).toString('hex')
      return `${exp}${rand}${tag}`
    },
    /** Nonce issued by this server to this party, not expired. Single use is via Login_Consume. */
    checkChallenge(party: string, nonce: string) {
      const m = /^([0-9a-f]{12})([0-9a-f]{16})([0-9a-f]{32})$/.exec(nonce)
      if (!m) return false
      const [, exp, rand, tag] = m as unknown as [string, string, string, string]
      const expected = mac(keys.challenge, `${party}|${exp}|${rand}`)
        .subarray(0, 16)
        .toString('hex')
      return equal(tag, expected) && parseInt(exp, 16) >= now()
    },
    issue(party: string) {
      const jti = randomBytes(12).toString('base64url')
      const payload = b64(JSON.stringify({ party, exp: now() + ttl, jti }))
      return `${payload}.${sign(keys.session, payload)}`
    },
    /**
     * One-time id until expiry (EVM wallet login nonce): true means first use. The same log
     * as for seals: both blue/green slots see a replay.
     */
    useOnce(id: string, expiresAt: number): boolean {
      return store.useSeal(`once:${id}`, expiresAt, now()) === 'ok'
    },
    /** Session lifetime, ms: cookie Max-Age (F-15). */
    ttlMs: ttl,
    /** Session from a valid, unrevoked token: party and expiry (GET /auth/session, F-15). */
    session(token: string | undefined): { party: string; expiresAt: number } | null {
      const p = decode(token)
      return p ? { party: p.party, expiresAt: p.exp } : null
    },
    /** party from a valid, unrevoked token, or null. */
    verify(token: string | undefined): string | null {
      return decode(token)?.party ?? null
    },
    /** Revoke a token (logout): true if it was valid and is now revoked. */
    revoke(token: string | undefined): boolean {
      const p = decode(token)
      if (!p?.jti) return false
      store.revoke(p.jti, p.exp)
      return true
    },
    /**
     * Signature of a server-built command: /dev/submit will not sign someone else's (audit K3).
     * Format `<iat>.<id>.<mac>`: still a string, so the client has nothing to change.
     */
    sealCommand(body: unknown) {
      const iat = now().toString(36)
      const id = randomBytes(12).toString('base64url')
      return `${iat}.${id}.${sign(keys.seal, `${iat}.${id}.${JSON.stringify(body)}`)}`
    },
    /** The seal is ours, not older than SEAL_TTL_MS and unused. A successful check consumes it. */
    checkSeal(body: unknown, seal: string): 'ok' | 'invalid' | 'expired' | 'reused' {
      const [iat, id, sig, ...rest] = seal.split('.')
      if (!iat || !id || !sig || rest.length) return 'invalid'
      if (!equal(sig, sign(keys.seal, `${iat}.${id}.${JSON.stringify(body)}`))) return 'invalid'
      const t = now()
      const issued = parseInt(iat, 36)
      if (!Number.isSafeInteger(issued) || issued > t + 5_000 || t - issued > SEAL_TTL_MS)
        return 'expired'
      const used = store.useSeal(id, issued + SEAL_TTL_MS, t)
      return used === 'full' ? 'expired' : used
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
