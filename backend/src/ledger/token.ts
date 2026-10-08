/**
 * Token for the JSON Ledger API.
 * - static: the token as is (or no token on a ledger without auth);
 * - client credentials: the role's service OIDC client (B-1, B-9), secret in a file;
 * - refresh: offline refresh token from the scripts/devnet-login.sh file (shared DevNet node).
 *
 * B-9: refresh does not storm the provider. After a failure there is an exponential pause during
 * which calls immediately get the same error. Forced refresh on 401 happens at most once per
 * FORCE_MIN_INTERVAL_MS. The refresh token is re-read from the file before refreshing (the other
 * blue/green slot may have rotated it); refresh and write happen under a file lock.
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

export interface TokenStatus {
  ok: boolean
  error: string | null
  /** Until when (ms) refresh is not retried after a failure */
  backoffUntil: number | null
}

export interface TokenSource {
  /** Authorization header, or null without auth. */
  header(force?: boolean): Promise<string | null>
  /** The token's `sub`: on OIDC nodes this is the ledger user id. */
  subject(): string | null
  status(): TokenStatus
}

export const FORCE_MIN_INTERVAL_MS = 30_000
export const BACKOFF_BASE_MS = 2_000
export const BACKOFF_MAX_MS = 300_000

const claims = (jwt: string): { sub?: string; exp?: number } => {
  const part = jwt.split('.')[1]
  if (!part) throw new Error('malformed JWT')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
    sub?: string
    exp?: number
  }
}

export function staticToken(token?: string): TokenSource {
  let sub: string | null = null
  try {
    sub = token ? (claims(token).sub ?? null) : null
  } catch {
    // opaque token: the user is set by LEDGER_USER_ID
  }
  return {
    header: async () => (token ? `Bearer ${token}` : null),
    subject: () => sub,
    status: () => ({ ok: true, error: null, backoffUntil: null }),
  }
}

interface Grant {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

/**
 * Shared part: access token cache, dedup of concurrent refreshes, backoff, force limit.
 * `renew` returns a new grant; renew errors do not contain the provider's response body.
 */
function cachedSource(renew: () => Promise<Grant>, now: () => number) {
  let access: string | null = null
  let expiresAt = 0
  let sub: string | null = null
  let inflight: Promise<void> | null = null
  let failures = 0
  let backoffUntil = 0
  let lastError: Error | null = null
  let lastForced = -Infinity

  async function run(): Promise<void> {
    try {
      const t = await renew()
      access = t.access_token
      let c: { sub?: string; exp?: number } = {}
      try {
        c = claims(access)
      } catch {
        // opaque access token: expiry from expires_in
      }
      sub = c.sub ?? sub
      expiresAt = c.exp ? c.exp * 1000 : now() + (t.expires_in ?? 300) * 1000
      failures = 0
      backoffUntil = 0
      lastError = null
    } catch (err) {
      failures++
      backoffUntil = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
      lastError = err instanceof Error ? err : new Error(String(err))
      throw lastError
    }
  }

  async function header(force = false): Promise<string> {
    const t = now()
    // a 401 for another reason must not hammer the provider: force at most once per interval
    const forced = force && t - lastForced >= FORCE_MIN_INTERVAL_MS
    const needed = forced || !access || t > expiresAt - 60_000
    if (needed) {
      if (!inflight && t < backoffUntil && lastError) {
        // in the pause after a failure: if the live token is still valid return it, else the same
        // error
        if (access && t < expiresAt) return `Bearer ${access}`
        throw lastError
      }
      if (forced) lastForced = t
      inflight ??= run().finally(() => {
        inflight = null
      })
      await inflight
    }
    return `Bearer ${access}`
  }

  return {
    header,
    subject: () => sub,
    status: (): TokenStatus => ({
      ok: lastError === null,
      error: lastError?.message ?? null,
      backoffUntil: backoffUntil > now() ? backoffUntil : null,
    }),
  }
}

async function postForm(
  doFetch: typeof fetch,
  url: string,
  form: Record<string, string>,
  hint: string,
): Promise<Grant> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(15_000),
  })
  // the OIDC response body is not logged: it may contain a token
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}; ${hint}`)
  const t = (await res.json()) as Grant
  if (!t.access_token) throw new Error(`token response without access_token; ${hint}`)
  return t
}

/** Service OIDC client (client credentials): no human and no refresh token (B-1, B-9). */
export async function clientCredentialsToken(opts: {
  tokenUrl: string
  clientId: string
  secretFile: string
  scope?: string
  audience?: string
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<TokenSource> {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const src = cachedSource(() => {
    // the secret is re-read: rotating the secret does not require a restart
    const secret = readFileSync(opts.secretFile, 'utf8').trim()
    return postForm(
      doFetch,
      opts.tokenUrl,
      {
        grant_type: 'client_credentials',
        client_id: opts.clientId,
        client_secret: secret,
        ...(opts.scope ? { scope: opts.scope } : {}),
        ...(opts.audience ? { audience: opts.audience } : {}),
      },
      `check the client secret in ${opts.secretFile}`,
    )
  }, now)
  await warmUp(src)
  return src
}

interface TokenFile {
  access_token?: string
  refresh_token: string
}

/** Token file lock: an O_EXCL file next to it; a stale lock older than 30 s is removed. */
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, 'wx', 0o600))
      break
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true })
      } catch {
        // the lock was already removed
      }
      if (i > 100) throw new Error(`token file ${file} is locked by another process`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

export async function refreshingToken(opts: {
  tokenUrl: string
  clientId: string
  file: string
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<TokenSource> {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const read = () => JSON.parse(readFileSync(opts.file, 'utf8')) as TokenFile
  if (!read().refresh_token)
    throw new Error(`${opts.file}: no refresh_token, run scripts/devnet-login.sh`)

  const src = cachedSource(
    () =>
      withFileLock(opts.file, async () => {
        // Another process may have already rotated the refresh token: take the one in the file
        // (B-9)
        const stored = read()
        const t = await postForm(
          doFetch,
          opts.tokenUrl,
          {
            grant_type: 'refresh_token',
            client_id: opts.clientId,
            refresh_token: stored.refresh_token,
          },
          'run scripts/devnet-login.sh again',
        )
        // The provider may issue a new refresh token: save it, otherwise the login is lost after a
        // restart
        if (t.refresh_token && t.refresh_token !== stored.refresh_token)
          writeFileSync(opts.file, JSON.stringify({ ...stored, refresh_token: t.refresh_token }), {
            mode: 0o600,
          })
        return t
      }),
    now,
  )
  await warmUp(src)
  return src
}

/**
 * Check the credential at startup. OIDC provider temporarily unavailable (5xx, network): do not
 * fail; the token is requested on the first ledger call, and /health/ready shows the error. A
 * substantive rejection (4xx: refresh token revoked, wrong secret) stops the process, as before.
 */
async function warmUp(src: TokenSource) {
  try {
    await src.header()
  } catch (e) {
    if (!/HTTP 5\d\d|fetch failed|timed? ?out|aborted|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(e)))
      throw e
    console.warn(`ledger token: provider unavailable at start, will retry: ${String(e)}`)
  }
}
