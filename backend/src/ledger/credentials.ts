/**
 * Ledger credentials per role (B-1, A-2). Each protocol role the backend submits
 * commands as is its own ledger user with its own rights:
 *
 *   LEDGER_<ROLE>_TOKEN                  static JWT
 *   LEDGER_<ROLE>_CLIENT_ID              service OIDC client (client credentials) …
 *   LEDGER_<ROLE>_CLIENT_SECRET_FILE     … and the file with its secret
 *   LEDGER_<ROLE>_REFRESH_TOKEN_FILE     or a human's refresh token (DevNet only)
 *   LEDGER_<ROLE>_TOKEN_URL              OIDC token endpoint (default LEDGER_TOKEN_URL)
 *   LEDGER_<ROLE>_SCOPE, _AUDIENCE       client credentials parameters
 *   LEDGER_<ROLE>_USER_ID                ledger user (else the token's sub)
 *
 * ROLE: OPERATOR, ORACLE, LIQUIDATOR, BACKSTOP, CUSTODY (custodian of EVM wallets, deployment.json
 * evm.custody: operations, deposits and withdrawals of real assets) and READER (only reads the ACS
 * on behalf of the operator, CanReadAs; without it reads use the operator credential). The same
 * keys without a role (LEDGER_TOKEN, …) are the default credential: on DevNet it stands in for
 * unset roles, on testnet/mainnet it only reads for other parties.
 *
 * Guardian, treasury and council members on testnet/mainnet sign with their own wallets:
 * the router refuses to submit commands for them (routedLedger).
 */
import { createHash } from 'node:crypto'
import type { Deployment } from '../deployment.ts'
import {
  type ActiveContract,
  type Command,
  createLedgerClient,
  type DisclosedContract,
  type LedgerClient,
  type SubmitOptions,
} from './client.ts'
import {
  clientCredentialsToken,
  refreshingToken,
  staticToken,
  type TokenSource,
  type TokenStatus,
} from './token.ts'

export const LEDGER_ROLES = [
  'operator',
  'oracle',
  'liquidator',
  'backstop',
  'custody',
  'reader',
] as const
export type LedgerRole = (typeof LEDGER_ROLES)[number]

/** Which ledger roles the bot needs. */
export const BOT_ROLES: Record<string, LedgerRole[]> = {
  oracle: ['oracle'],
  attestation: ['oracle'],
  accounts: ['operator'],
  // absorb: the operator alone sees accounts (K5)
  absorber: ['operator'],
  // buyers read their own USDCx and the pool snapshot on behalf of the operator: the read-only
  // reader is enough, a buyer process never holds the operator's signing rights (review 03.10, 19)
  liquidator: ['liquidator', 'reader'],
  backstop: ['backstop', 'reader'],
  merge: ['operator'],
  logins: ['operator'],
  indexer: ['operator'],
  // Real assets (real profile): the custodian accepts transfers and burns USDCx,
  // the operator opens accounts and reads the catalog
  deposits: ['custody', 'operator'],
  redeems: ['custody', 'operator'],
}

interface Base {
  userId?: string
  /** Who this is on the ledger: to check that roles do not share a user */
  identity: string
}
export type Credential = Base &
  (
    | { kind: 'static'; token: string }
    | {
        kind: 'client-credentials'
        tokenUrl: string
        clientId: string
        secretFile: string
        scope?: string
        audience?: string
      }
    | { kind: 'refresh'; tokenUrl: string; clientId: string; file: string }
  )

export type Credentials = Record<LedgerRole | 'default', Credential | undefined>

const sub = (jwt: string): string | undefined => {
  try {
    const part = jwt.split('.')[1]
    return part
      ? (JSON.parse(Buffer.from(part, 'base64url').toString()) as { sub?: string }).sub
      : undefined
  } catch {
    return undefined
  }
}

function credentialFrom(env: NodeJS.ProcessEnv, prefix: string): Credential | undefined {
  const get = (k: string) => env[`${prefix}${k}`] || undefined
  const userId = get('USER_ID')
  const tokenUrl = get('TOKEN_URL') ?? env.LEDGER_TOKEN_URL
  const clientId = get('CLIENT_ID')
  const secretFile = get('CLIENT_SECRET_FILE')
  const refreshFile = get('REFRESH_TOKEN_FILE')
  const token = get('TOKEN')
  const withBase = (
    c: { kind: Credential['kind'] } & Record<string, unknown>,
    fallback: string,
  ): Credential =>
    ({ ...c, ...(userId ? { userId } : {}), identity: userId ?? fallback }) as Credential
  if (clientId && secretFile) {
    if (!tokenUrl)
      throw new Error(`${prefix}CLIENT_ID needs ${prefix}TOKEN_URL or LEDGER_TOKEN_URL`)
    return withBase(
      {
        kind: 'client-credentials',
        tokenUrl,
        clientId,
        secretFile,
        ...(get('SCOPE') ? { scope: get('SCOPE')! } : {}),
        ...(get('AUDIENCE') ? { audience: get('AUDIENCE')! } : {}),
      },
      `client:${clientId}`,
    )
  }
  if (refreshFile) {
    if (!tokenUrl || !clientId)
      throw new Error(`${prefix}REFRESH_TOKEN_FILE needs a client id and a token URL`)
    // refresh token of a personal login: one user per file
    return withBase(
      { kind: 'refresh', tokenUrl, clientId, file: refreshFile },
      `refresh:${refreshFile}`,
    )
  }
  if (token)
    return withBase(
      { kind: 'static', token },
      sub(token) ?? `token:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`,
    )
  return undefined
}

export function parseCredentials(env: NodeJS.ProcessEnv): Credentials {
  const out = { default: credentialFrom(env, 'LEDGER_') } as Credentials
  // No role: LEDGER_CLIENT_ID with LEDGER_REFRESH_TOKEN_FILE is the old DevNet scheme
  for (const r of LEDGER_ROLES) out[r] = credentialFrom(env, `LEDGER_${r.toUpperCase()}_`)
  return out
}

export async function tokenSource(c: Credential | undefined): Promise<TokenSource> {
  if (!c) return staticToken()
  switch (c.kind) {
    case 'static':
      return staticToken(c.token)
    case 'client-credentials':
      return clientCredentialsToken({
        tokenUrl: c.tokenUrl,
        clientId: c.clientId,
        secretFile: c.secretFile,
        ...(c.scope ? { scope: c.scope } : {}),
        ...(c.audience ? { audience: c.audience } : {}),
      })
    case 'refresh':
      return refreshingToken({ tokenUrl: c.tokenUrl, clientId: c.clientId, file: c.file })
  }
}

export class NoCredentialError extends Error {}
export class SigningForbiddenError extends Error {}

export type Route = LedgerRole | 'default'

/**
 * Client that picks the credential by the request's party. Protocol code is unchanged:
 * query(party), submit(actAs) and updates(party) go to the credential whose role it is.
 */
export function routedLedger(opts: {
  deployment: Pick<Deployment, 'operator' | 'oracle' | 'liquidator' | 'backstop'> &
    Partial<Pick<Deployment, 'evm'>>
  clients: Partial<Record<Route, LedgerClient>>
  /** false: unset roles are not replaced by the default credential (testnet/mainnet) */
  fallback: boolean
  /** false: submit only for protocol roles (testnet/mainnet) */
  signForOthers: boolean
}): LedgerClient & { routeOf(party: string, purpose: 'read' | 'submit'): Route } {
  const d = opts.deployment
  const roleOf = (party: string, purpose: 'read' | 'submit'): Route => {
    if (party === d.operator)
      return purpose === 'read' && opts.clients.reader ? 'reader' : 'operator'
    if (party === d.oracle) return 'oracle'
    if (party === d.liquidator) return 'liquidator'
    if (party === d.backstop) return 'backstop'
    if (d.evm?.custody && party === d.evm.custody) return 'custody'
    return 'default'
  }
  const routeOf = (party: string, purpose: 'read' | 'submit'): Route => {
    const role = roleOf(party, purpose)
    if (opts.clients[role]) return role
    if (role !== 'default' && opts.fallback && opts.clients.default) return 'default'
    throw new NoCredentialError(`no ledger credential for role ${role}`)
  }
  const client = (party: string, purpose: 'read' | 'submit') =>
    opts.clients[routeOf(party, purpose)]!
  const any = () =>
    opts.clients.default ??
    opts.clients.operator ??
    opts.clients.reader ??
    Object.values(opts.clients).find(Boolean)!

  return {
    routeOf,
    ledgerEnd: () => any().ledgerEnd(),
    prunedOffset: () => any().prunedOffset(),
    participantId: () => any().participantId(),
    version: (t?: number) => any().version(t),
    query: <T>(party: string, filter: { templateId: string } | { interfaceId: string }) =>
      client(party, 'read').query<T>(party, filter) as Promise<ActiveContract<T>[]>,
    updates: (party, ...rest) => client(party, 'read').updates(party, ...rest),
    transactions: (party, ...rest) => client(party, 'read').transactions(party, ...rest),
    createdEvent: (party, ...rest) => client(party, 'read').createdEvent(party, ...rest),
    async submit(
      actAs: string[],
      commands: Command[],
      disclosed: DisclosedContract[] = [],
      readAs: string[] = [],
      options: SubmitOptions = {},
    ) {
      const routes = new Set(actAs.map((p) => roleOf(p, 'submit')))
      if (!opts.signForOthers && routes.has('default'))
        throw new SigningForbiddenError(
          'the backend signs only for operator, oracle, liquidator, backstop and custody on this network',
        )
      const chosen = new Set(actAs.map((p) => routeOf(p, 'submit')))
      if (chosen.size !== 1)
        throw new NoCredentialError(`actAs ${actAs.join(', ')} spans several ledger users`)
      return client(actAs[0]!, 'submit').submit(actAs, commands, disclosed, readAs, options)
    },
  }
}

export interface RoleLedgers {
  ledger: ReturnType<typeof routedLedger>
  /** Token state per role for /health/ready */
  status(): Record<string, TokenStatus>
  /**
   * Token of the role's credential: the Amulet registry (scan-proxy) only accepts the validator's
   * token
   */
  tokens: Partial<Record<Route, TokenSource>>
}

export async function createRoleLedgers(
  config: {
    LEDGER_API_URL: string
    LEDGER_PAGE_SIZE?: number
    LEDGER_MAX_PAGES?: number
    credentials: Credentials
    publicNetwork: boolean
  },
  d: Pick<Deployment, 'operator' | 'oracle' | 'liquidator' | 'backstop'> &
    Partial<Pick<Deployment, 'evm'>>,
): Promise<RoleLedgers> {
  const clients: Partial<Record<Route, LedgerClient>> = {}
  const tokens: Partial<Record<Route, TokenSource>> = {}
  const routes: Route[] = ['default', ...LEDGER_ROLES]
  for (const r of routes) {
    const c = config.credentials[r]
    // default credential without a token only outside testnet/mainnet (ledger without auth: tests)
    if (!c && !(r === 'default' && !config.publicNetwork)) continue
    const src = await tokenSource(c)
    tokens[r] = src
    clients[r] = createLedgerClient(
      {
        LEDGER_API_URL: config.LEDGER_API_URL,
        LEDGER_USER_ID: c?.userId,
        ...(config.LEDGER_PAGE_SIZE ? { LEDGER_PAGE_SIZE: config.LEDGER_PAGE_SIZE } : {}),
        ...(config.LEDGER_MAX_PAGES ? { LEDGER_MAX_PAGES: config.LEDGER_MAX_PAGES } : {}),
      },
      src,
    )
  }
  if (Object.keys(clients).length === 0)
    throw new Error('no ledger credentials configured (LEDGER_<ROLE>_* or LEDGER_TOKEN)')
  return {
    ledger: routedLedger({
      deployment: d,
      clients,
      fallback: !config.publicNetwork,
      signForOthers: !config.publicNetwork,
    }),
    tokens,
    status: () => Object.fromEntries(Object.entries(tokens).map(([r, t]) => [r, t.status()])),
  }
}
