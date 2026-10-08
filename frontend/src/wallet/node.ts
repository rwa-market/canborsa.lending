/**
 * Node wallet: sign-in with the node's OIDC account (NODERS AuthFactory on HackCanton DevNet) and
 * transaction signing with the user's own token via the node's JSON Ledger API.
 *
 * The user's party lives on the same node as the protocol packages, so the node executes the
 * user's commands on their behalf; the backend never sees the token and does not sign for the user.
 *
 * Security (agreement with wallet/verify.ts):
 * - PKCE S256 and state; redirect_uri exactly `${origin}/auth/callback`;
 * - access and refresh tokens only in module memory: no localStorage, no sessionStorage,
 *   no logs. Only verifier and state sit in sessionStorage during the redirect;
 * - actAs is the one chosen party, no readAs, disclosed contracts only from prepared.
 * Submission only via wallet.submit in context.tsx: it runs verifyPrepared and the network check.
 */
import type { InstrumentId, PreparedCommand } from '@lending/shared'
import type { Holding } from './holdings'
import { CORE_PACKAGE, type OfferSeen, TEMPLATES, TRANSFER_INSTRUCTION } from './verify'

const env = import.meta.env
/** Node OIDC issuer and its client: pinned in the build, the API cannot substitute them. */
const ISSUER = (env.VITE_NODE_OIDC_ISSUER as string | undefined)?.trim() || null
const CLIENT_ID = (env.VITE_NODE_OIDC_CLIENT_ID as string | undefined)?.trim() || null
/** Node JSON Ledger API. */
const LEDGER = (env.VITE_NODE_LEDGER_URL as string | undefined)?.trim().replace(/\/$/, '') || null
/** Node wallet (party onboarding): where to send a user without a party. */
export const NODE_WALLET_URL = (env.VITE_NODE_WALLET_URL as string | undefined)?.trim() || null

const HOLDING = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding'
const PKCE_KEY = 'lending.node.pkce'
export const ACS_LIMIT = 200

/** The node wallet is included in this build. */
export const nodeWalletEnabled = () => !!(ISSUER && CLIENT_ID && LEDGER)

export class NodeWalletError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------- in-memory tokens

interface Tokens {
  access: string
  refresh: string | null
  /** epoch ms when access expires */
  expiresAt: number
  /** token sub: the ledger user */
  user: string
}
let tokens: Tokens | null = null

const redirectUri = () => `${window.location.origin}/auth/callback`
const endpoint = (path: 'auth' | 'token' | 'logout') => `${ISSUER}/protocol/openid-connect/${path}`

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)))

async function challengeOf(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return b64url(new Uint8Array(digest))
}

function claimsOf(jwt: string): { sub?: string; exp?: number } {
  try {
    const p = jwt.split('.')[1] ?? ''
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as {
      sub?: string
      exp?: number
    }
  } catch {
    return {}
  }
}

function accept(r: { access_token: string; refresh_token?: string; expires_in: number }) {
  const sub = claimsOf(r.access_token).sub
  if (!sub) throw new NodeWalletError('the node login returned a token without a user')
  tokens = {
    access: r.access_token,
    refresh: r.refresh_token ?? null,
    expiresAt: Date.now() + r.expires_in * 1000,
    user: sub,
  }
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(endpoint('token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID!, ...body }),
  })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error_description?: string
    error?: string
  }
  if (!res.ok || !json.access_token || !json.expires_in)
    throw new NodeWalletError(
      `node login failed: ${json.error_description ?? json.error ?? res.status}`,
      'LOGIN_FAILED',
    )
  accept({
    access_token: json.access_token,
    expires_in: json.expires_in,
    ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
  })
}

/** Valid access token; refreshed with the refresh token a minute before expiry. */
async function accessToken(): Promise<string> {
  if (!tokens) throw new NodeWalletError('sign in with the node wallet first', 'NO_SESSION')
  if (Date.now() < tokens.expiresAt - 60_000) return tokens.access
  if (!tokens.refresh) throw new NodeWalletError('the node session expired', 'NO_SESSION')
  await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh })
  return tokens.access
}

/**
 * Go to the node sign-in page. `silent` means prompt=none: with a live Keycloak session
 * it returns without a form (the in-memory token is lost after a page reload).
 * `next` is where to return after sign-in.
 */
export async function nodeLogin(opts: { silent?: boolean; next?: string } = {}) {
  if (!nodeWalletEnabled()) throw new NodeWalletError('the node wallet is not configured')
  const verifier = random(48)
  const state = random(24)
  sessionStorage.setItem(
    PKCE_KEY,
    JSON.stringify({ verifier, state, next: opts.next ?? window.location.pathname }),
  )
  const url = new URL(endpoint('auth'))
  url.search = new URLSearchParams({
    client_id: CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid daml_ledger_api',
    state,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
    ...(opts.silent ? { prompt: 'none' } : {}),
  }).toString()
  window.location.assign(url.toString())
}

/**
 * /auth/callback page: exchange the code for tokens. Returns the path to return to.
 * state is checked against the saved one; verifier is single-use.
 */
export async function nodeCompleteLogin(search: string): Promise<string> {
  const q = new URLSearchParams(search)
  const raw = sessionStorage.getItem(PKCE_KEY)
  sessionStorage.removeItem(PKCE_KEY)
  const saved = raw ? (JSON.parse(raw) as { verifier: string; state: string; next?: string }) : null
  if (!saved || q.get('state') !== saved.state)
    throw new NodeWalletError('the node login answer does not match this browser', 'STATE')
  const err = q.get('error')
  if (err)
    throw new NodeWalletError(
      err === 'login_required' ? 'sign in to the node wallet' : `node login: ${err}`,
      err === 'login_required' ? 'LOGIN_REQUIRED' : 'LOGIN_FAILED',
    )
  const code = q.get('code')
  if (!code) throw new NodeWalletError('the node login returned no code', 'LOGIN_FAILED')
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: saved.verifier,
  })
  return saved.next && saved.next.startsWith('/') && !saved.next.startsWith('//') ? saved.next : '/'
}

export const nodeSignedIn = () => tokens !== null

/** Forget the tokens; the Keycloak session stays: sign-out of the node account is done there. */
export function nodeLogout() {
  tokens = null
}

// ---------------------------------------------------------------- JSON Ledger API

async function ledger<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${LEDGER}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const cause = (json as { cause?: string; message?: string } | null)?.cause
    throw new NodeWalletError(
      `node ledger ${res.status}: ${cause ?? (json as { message?: string } | null)?.message ?? text.slice(0, 200)}`,
      res.status === 409 ? 'BUSY' : `HTTP_${res.status}`,
    )
  }
  return json as T
}

/** Parties the user can act as, and the primary one from onboarding. */
export async function nodeParties(): Promise<{ primary: string | null; parties: string[] }> {
  const user = tokens?.user
  if (!user) throw new NodeWalletError('sign in with the node wallet first', 'NO_SESSION')
  const [u, r] = await Promise.all([
    ledger<{ user?: { primaryParty?: string } }>('GET', `/v2/users/${encodeURIComponent(user)}`),
    ledger<{ rights?: { kind?: Record<string, { value?: { party?: string } }> }[] }>(
      'GET',
      `/v2/users/${encodeURIComponent(user)}/rights`,
    ),
  ])
  const parties = (r.rights ?? []).flatMap((x) => {
    const p = x.kind?.CanActAs?.value?.party
    return p ? [p] : []
  })
  const primary = u.user?.primaryParty || null
  return { primary: primary && parties.includes(primary) ? primary : null, parties }
}

/**
 * Execute the prepared command as party. commandId comes from the caller: one
 * user intent; the ledger drops a retry with the same id as a duplicate.
 */
export async function nodeSubmit(
  prepared: PreparedCommand,
  party: string,
  commandId: string,
): Promise<{ updateId: string }> {
  if (prepared.actAs.length !== 1 || prepared.actAs[0] !== party)
    throw new NodeWalletError('the command acts for another party')
  const r = await ledger<{ updateId?: string }>('POST', '/v2/commands/submit-and-wait', {
    commands: prepared.commands,
    commandId,
    userId: tokens!.user,
    actAs: [party],
    readAs: [],
    disclosedContracts: prepared.disclosedContracts,
  })
  if (typeof r.updateId !== 'string')
    throw new NodeWalletError('the node did not confirm the transaction', 'NOT_EXECUTED')
  return { updateId: r.updateId }
}

interface CreatedEvent {
  contractId: string
  packageName?: string
  createArgument?: Record<string, unknown>
  interfaceViews?: {
    viewValue?: { owner: string; amount: string; lock: unknown; instrumentId: InstrumentId }
  }[]
}

async function activeContracts(party: string, identifierFilter: unknown) {
  const end = await ledger<{ offset: number }>('GET', '/v2/state/ledger-end')
  const list = await ledger<
    { contractEntry?: { JsActiveContract?: { createdEvent: CreatedEvent } } }[]
  >('POST', `/v2/state/active-contracts?limit=${ACS_LIMIT}`, {
    filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter }] } } },
    verbose: false,
    activeAtOffset: end.offset,
  })
  return (Array.isArray(list) ? list : []).flatMap((r) => {
    const e = r.contractEntry?.JsActiveContract?.createdEvent
    return e ? [e] : []
  })
}

/** The user's free holdings by instrument: from their node, not from the protocol API. */
export async function nodeHoldings(party: string, instrument: InstrumentId): Promise<Holding[]> {
  const events = await activeContracts(party, {
    InterfaceFilter: { value: { interfaceId: HOLDING, includeInterfaceView: true } },
  })
  return events.flatMap((e) => {
    const v = e.interfaceViews?.[0]?.viewValue
    if (!v || v.owner !== party || v.lock) return []
    if (v.instrumentId.admin !== instrument.admin || v.instrumentId.id !== instrument.id) return []
    return [{ cid: e.contractId, amount: v.amount }]
  })
}

/** The user's account from their node (F-1): owner is the user, operator the expected operator. */
export async function nodeAccount(party: string, operator: string): Promise<string | null> {
  const events = await activeContracts(party, {
    TemplateFilter: { value: { templateId: TEMPLATES.account, includeCreatedEventBlob: false } },
  })
  const mine = events.filter(
    (e) =>
      (e.packageName === undefined || e.packageName === CORE_PACKAGE) &&
      e.createArgument?.owner === party &&
      e.createArgument?.operator === operator,
  )
  return mine[0]?.contractId ?? null
}

/** Live ProtocolConfig from the council member's node: proposals checked against it, not API. */
export async function nodeConfig(party: string, configCid: string) {
  const events = await activeContracts(party, {
    TemplateFilter: { value: { templateId: TEMPLATES.config, includeCreatedEventBlob: false } },
  })
  const e = events.find(
    (x) =>
      x.contractId === configCid && (x.packageName === undefined || x.packageName === CORE_PACKAGE),
  )
  const args = e?.createArgument
  if (!e || !args) return null
  return { contractId: e.contractId, params: args.params, marketParams: args.marketParams }
}

/**
 * Incoming transfer by id, from the user's node (the user is the receiver and sees the contract).
 * The faucet returns only the id; the wallet checks sender, amount and instrument itself.
 */
export async function nodeOffer(party: string, offerCid: string): Promise<OfferSeen | null> {
  const events = await activeContracts(party, {
    InterfaceFilter: { value: { interfaceId: TRANSFER_INSTRUCTION, includeInterfaceView: true } },
  })
  const e = events.find((x) => x.contractId === offerCid)
  const t = (e?.interfaceViews?.[0]?.viewValue as { transfer?: OfferSeen } | undefined)?.transfer
  return t
    ? { sender: t.sender, receiver: t.receiver, instrumentId: t.instrumentId, amount: t.amount }
    : null
}

/** Synchronizers the node connected the party to: network check before signing. */
export async function nodeSynchronizers(party: string): Promise<string[]> {
  const r = await ledger<{ connectedSynchronizers?: { synchronizerId?: string }[] }>(
    'GET',
    `/v2/state/connected-synchronizers?party=${encodeURIComponent(party)}`,
  )
  return (r.connectedSynchronizers ?? []).flatMap((s) =>
    s.synchronizerId ? [s.synchronizerId] : [],
  )
}
