/**
 * Wallet network check, fail-closed (audit F-4, seam 10 in fix-contracts).
 * Signing is allowed only if the wallet network is known and matches the expected one.
 * The expected network comes from the build (VITE_EXPECTED_NETWORK_ID) and backend /config;
 * if both are set, they must match.
 */

export type NetworkVerdict = { ok: true; network: string | null } | { ok: false; reason: string }

export interface NetworkInput {
  /** Network from the backend /config, or null */
  expected: string | null
  /** Network pinned in the build, or null */
  pinned: string | null
  /** Network reported by the wallet, or null */
  wallet: string | null
  /** The wallet reported it is connected to the network (ConnectResult.isNetworkConnected) */
  walletConnected: boolean
  /** Dev build only: a server without networkId (local backend) does not block */
  allowUndeclared: boolean
}

export function checkNetwork(i: NetworkInput): NetworkVerdict {
  if (i.pinned && i.expected && i.pinned !== i.expected)
    return {
      ok: false,
      reason: `the app is built for ${i.pinned}, but the server runs on ${i.expected}`,
    }
  const target = i.pinned ?? i.expected
  if (!target)
    return i.allowUndeclared
      ? { ok: true, network: i.wallet }
      : { ok: false, reason: 'the server does not declare its network' }
  if (!i.walletConnected) return { ok: false, reason: 'your wallet is not connected to a network' }
  if (!i.wallet) return { ok: false, reason: 'your wallet did not report its network' }
  if (i.wallet !== target)
    return { ok: false, reason: `your wallet is on ${i.wallet}, the protocol runs on ${target}` }
  return { ok: true, network: i.wallet }
}

/**
 * Expected network from the /config response. The backend adds a `network` field (seam 10); old
 * `networkId` is read as a fallback. `network` is a string or an object with `networkId`.
 */
export function expectedNetwork(config: unknown): string | null {
  if (typeof config !== 'object' || config === null) return null
  const c = config as { network?: unknown; networkId?: unknown }
  const n = c.network
  if (typeof n === 'string' && n) return n
  if (typeof n === 'object' && n !== null) {
    const id = (n as { networkId?: unknown }).networkId
    if (typeof id === 'string' && id) return id
  }
  return typeof c.networkId === 'string' && c.networkId ? c.networkId : null
}
