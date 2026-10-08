/**
 * API session (audit F-15, seam 2): the token lives in the httpOnly cookie `lending_session`,
 * page script cannot see it and stores it nowhere. The server knows the session:
 * - GET /auth/session → `{ party, expiresAt }` or 401;
 * - POST /auth/logout clears the cookie.
 *
 * The browser keeps only a hint with no secret: which wallet was used to sign in,
 * so that after a reload it knows how to restore the session.
 * Module without React and alias imports: vitest runs it.
 */
import { z } from 'zod'

const PARTY = /^[\w.-]{1,128}::[0-9a-f]{8,128}$/
/** Loop account (0.7.0): the session is issued to the subject `loop:<party>` */
const LOOP_SUBJECT = /^loop:[\w.-]{1,185}::[0-9a-f]{8,128}$/

/** GET /auth/session response. */
export const serverSession = z.object({
  party: z.string().refine((v) => PARTY.test(v) || LOOP_SUBJECT.test(v), 'party or loop:<party>'),
  expiresAt: z.iso.datetime({ offset: true }),
})

export type ServerSession = z.infer<typeof serverSession>

/**
 * loop: a user; node: protocol roles only (guardian, treasury, council,
 * liquidator, backstop), sign-in on /operator.
 */
export type WalletKind = 'node' | 'loop'

/**
 * Protocol role pages: the node wallet session is restored here. On the others
 * (dashboard, markets, reserve) the node wallet is not restored: users sign in only with Loop.
 */
const NODE_PATHS = ['/operator', '/admin', '/liquidations', '/council']
const NODE_CALLBACK = '/auth/callback'

const onNodePage = (path: string) => NODE_PATHS.some((p) => path === p || path.startsWith(`${p}/`))

/** The server session is valid: the shape is correct and it has not expired yet. */
export function liveSession(v: unknown, now = Date.now()): ServerSession | null {
  const r = serverSession.safeParse(v)
  if (!r.success) return null
  return Date.parse(r.data.expiresAt) > now ? r.data : null
}

/** In how many ms to reset the session on expiry; setTimeout accepts no more than 2^31−1. */
export function expiryDelay(expiresAt: string, now = Date.now()): number {
  const t = Date.parse(expiresAt)
  if (!Number.isFinite(t)) return 0
  return Math.min(Math.max(t - now, 0), 2 ** 31 - 1)
}

/**
 * How to restore the session after a reload:
 * - loop: Loop; the SDK session from localStorage, the party must match the session;
 * - node: protocol role node wallet, only on its pages: silent OIDC sign-in for the same party;
 * - node-callback: return from OIDC sign-in; /auth/callback calls connectNode itself;
 * - none: no session, or a node wallet on a user page; discard the cookie.
 * No hint (new tab): none. The old evm hint: none, there is no EVM sign-in.
 */
export function restorePlan(
  session: ServerSession | null,
  hint: WalletKind | null,
  path = '/',
): WalletKind | 'node-callback' | 'none' {
  if (!session) return 'none'
  if (hint === 'loop') return 'loop'
  if (hint === 'node') {
    if (path === NODE_CALLBACK) return 'node-callback'
    if (onNodePage(path)) return 'node'
  }
  return 'none'
}

const HINT_KEY = 'lending.wallet.v3'
/** Old formats stored the token: they are removed on every start. */
const LEGACY_KEYS = ['lending.session', 'lending.session.v2']

const safe = (fn: () => void) => {
  try {
    fn()
  } catch {
    // private mode or storage blocked: there is simply no hint
  }
}

export function purgeLegacyTokens() {
  safe(() => {
    for (const k of LEGACY_KEYS) {
      sessionStorage.removeItem(k)
      localStorage.removeItem(k)
    }
  })
}

export function rememberedWallet(): WalletKind | null {
  let v: string | null = null
  safe(() => {
    v = localStorage.getItem(HINT_KEY)
  })
  return v === 'node' || v === 'loop' ? v : null
}

export function rememberWallet(kind: WalletKind | null) {
  safe(() => {
    if (kind) localStorage.setItem(HINT_KEY, kind)
    else localStorage.removeItem(HINT_KEY)
  })
}
