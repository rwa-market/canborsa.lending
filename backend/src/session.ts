/**
 * F-15: browser session in an httpOnly cookie (agreement, item 2). XSS cannot read the token:
 * the frontend does not store it, the browser sends the cookie itself (`credentials:
 * 'same-origin'`).
 *
 * - `lending_session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<ttl>`, plus `Secure`
 *   if the request came over https (including `X-Forwarded-Proto: https` from a trusted proxy:
 *   Fastify honors the header only from TRUSTED_PROXIES addresses).
 * - CSRF: the browser attaches the cookie itself, so a non-GET authenticated by cookie requires
 *   `X-Lending-Client: web` (a foreign page cannot set the header without a preflight) and an
 *   `Origin` from the allow list. Otherwise 403. Bearer and X-Session-Token need no check: the
 *   client sets them explicitly, the browser does not send them on its own.
 *
 * Cookie parsing and building are our own: one name, a base64url value with a dot, no
 * @fastify/cookie.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

export const SESSION_COOKIE = 'lending_session'
export const CLIENT_HEADER = 'x-lending-client'
export const CLIENT_WEB = 'web'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Value of cookie `name` from the Cookie header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const v = part.slice(eq + 1).trim()
    return v || undefined
  }
  return undefined
}

const isHttps = (req: FastifyRequest) => req.protocol === 'https'

function serialize(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function setSessionCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  token: string,
  ttlMs: number,
) {
  void reply.header('set-cookie', serialize(token, ttlMs / 1000, isHttps(req)))
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply) {
  void reply.header('set-cookie', serialize('', 0, isHttps(req)))
}

/** Token from client headers: X-Session-Token, otherwise Authorization: Bearer. */
export function headerToken(req: FastifyRequest): string | undefined {
  const own = req.headers['x-session-token']
  if (typeof own === 'string' && own) return own
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) || undefined : undefined
}

export const cookieToken = (req: FastifyRequest) => readCookie(req.headers.cookie, SESSION_COOKIE)

/**
 * Allowed Origins: CORS_ORIGIN (comma-separated) and ALLOWED_HOSTS with http and https.
 * Strict comparison of the whole string: `https://lending.example.evil` will not pass.
 */
export function allowedOrigins(c: { CORS_ORIGIN: string; ALLOWED_HOSTS: string[] }): string[] {
  const out = new Set<string>()
  for (const o of c.CORS_ORIGIN.split(',')) if (o.trim()) out.add(o.trim().replace(/\/$/, ''))
  for (const h of c.ALLOWED_HOSTS) {
    out.add(`http://${h}`)
    out.add(`https://${h}`)
  }
  return [...out]
}

/**
 * CSRF check (onRequest): null means the request may pass, otherwise the rejection reason.
 * Only unsafe methods that have no token in a header but do have a cookie are checked.
 */
export function csrfViolation(req: FastifyRequest, allowed: ReadonlySet<string>): string | null {
  if (SAFE_METHODS.has(req.method)) return null
  if (headerToken(req)) return null
  if (!cookieToken(req)) return null
  if (req.headers[CLIENT_HEADER] !== CLIENT_WEB) return `missing ${CLIENT_HEADER}: ${CLIENT_WEB}`
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !allowed.has(origin)) return 'origin not allowed'
  return null
}
