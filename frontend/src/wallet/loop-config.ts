/**
 * /config.loop (LOOP_WALLETS): Loop wallet sign-in is enabled: SDK network and account custodian.
 * Read without loading the SDK: the wallet picker uses it to decide whether to show Loop.
 * Module without React and alias imports: vitest runs it.
 */
import { expectedNetwork } from './network.ts'

/** @fivenorth/loop-sdk 0.15.0 networks that the backend returns (LoopConfig.network) */
export type LoopSdkNetwork = 'devnet' | 'testnet' | 'mainnet'

export interface LoopConfig {
  /**
   * Canton network in signed texts (LoopWallet.network): backend networkId, as for EVM accounts;
   * a server without networkId gives `canton`, the same way the backend substitutes it.
   */
  network: string
  /** Custodian party: executes Pool_LoopWalletExecute */
  custody: string
  /** SDK network for loop.init */
  sdkNetwork: LoopSdkNetwork
}

const SDK_NETWORKS: readonly string[] = ['devnet', 'testnet', 'mainnet']

/** Loop config from /config, or null (disabled, old backend, incomplete response). */
export function loopConfigOf(config: unknown): LoopConfig | null {
  const raw = (config as { loop?: unknown } | null | undefined)?.loop as
    { enabled?: unknown; network?: unknown; custody?: unknown } | null | undefined
  if (!raw || raw.enabled !== true) return null
  if (typeof raw.custody !== 'string' || !raw.custody) return null
  if (typeof raw.network !== 'string' || !SDK_NETWORKS.includes(raw.network)) return null
  return {
    network: expectedNetwork(config) ?? 'canton',
    custody: raw.custody,
    sdkNetwork: raw.network as LoopSdkNetwork,
  }
}
