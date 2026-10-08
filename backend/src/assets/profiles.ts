/**
 * Network asset profiles (seam 2, ADR-005). `test`: the deployment's test tokens, as on
 * DevNet before 0.6.0: nothing from this file is used. `real`: real CC (Amulet),
 * USDCx (DA Utilities, Circle xReserve) and CBTC (BitSafe) on testnet and mainnet.
 *
 * Values come from the research docs/reports/research-2026-10-01-real-assets.md, only those
 * marked [V]/[L]: InstrumentId, admin parties, registry URL, bridge operators, xReserve
 * and USDC contracts, Canton domain. Unknowns are TODO in the config, no made-up values.
 * ETH and SOL are not in the profile: there are no Canton versions (BETH not launched).
 */
import type { Instrument } from '../deployment.ts'

export const ASSET_PROFILES = ['test', 'real'] as const
export type AssetProfileName = (typeof ASSET_PROFILES)[number]

/** Networks with profile real: DevNet has no real assets. */
export const REAL_NETWORKS = ['testnet', 'mainnet'] as const
export type RealNetwork = (typeof REAL_NETWORKS)[number]

/** Transfer meta key carrying the deposit memo (CIP-0056, guidance.mdx "Sending Deposits"). */
export const REASON_META_KEY = 'splice.lfdecentralizedtrust.org/reason'
/** Meta key carrying the transfer sender (Token Standard tx history). */
export const SENDER_META_KEY = 'splice.lfdecentralizedtrust.org/sender'
export const TX_KIND_META_KEY = 'splice.lfdecentralizedtrust.org/tx-kind'
/** EVM wallet deposit memo: `lending:evm:<address>` (seam 2). */
export const DEPOSIT_REASON_PREFIX = 'lending:evm:'

/** DA Utilities bridge templates (guidance.mdx, "USDCx Support for Wallets") [V]. */
export const BRIDGE_TEMPLATES = {
  userAgreementRequest:
    '#utility-bridge-v0:Utility.Bridge.V0.Agreement.User:BridgeUserAgreementRequest',
  userAgreement: '#utility-bridge-v0:Utility.Bridge.V0.Agreement.User:BridgeUserAgreement',
  depositAttestation: '#utility-bridge-v0:Utility.Bridge.V0.Attestation.Deposit:DepositAttestation',
} as const

/** CC TransferPreapproval (exchanges/guidance.mdx, treasury-party-setup) [V]. */
export const PREAPPROVAL_TEMPLATES = {
  proposal: '#splice-wallet:Splice.Wallet.TransferPreapproval:TransferPreapprovalProposal',
  preapproval: '#splice-amulet:Splice.AmuletRules:TransferPreapproval',
} as const

/** Ethereum in xReserve: burn destination domain (guidance.mdx: "domain id of 0") [V]. */
export const ETHEREUM_DOMAIN = '0'
/** Canton domain in xReserve (Circle: supported blockchains and domains) [V]. */
export const CANTON_DOMAIN = 10001
/** USDC on Ethereum has 6 decimals; USDCx burn accepts at most 6 [V]. */
export const USDC_DECIMALS = 6

export interface XreserveProfile {
  /** EIP-155: 1 — Ethereum, 11155111 — Sepolia */
  chainId: number
  /** xReserve contract, lowercase */
  contract: string
  /** USDC on this network, lowercase */
  usdc: string
  cantonDomain: number
}

export interface RealProfile {
  network: RealNetwork
  instruments: { usdcx: Instrument; cc: Instrument; cbtc: Instrument }
  /** Registry API (CIP-0056) base per slot: the adapter appends /registry/… */
  registries: { usdcx: string; cc: string; cbtc: string }
  /** DA Utilities backend: burn-mint-factory USDCx */
  utilitiesBackend: string
  bridge: { utilityOperator: string; bridgeOperator: string }
  xreserve: XreserveProfile
}

const DA_MAINNET = 'https://api.utilities.digitalasset.com'
const DA_TESTNET = 'https://api.utilities.digitalasset-staging.com'
const registrar = (backend: string, admin: string) =>
  `${backend}/api/token-standard/v0/registrars/${admin}`

const USDCX_MAINNET =
  'decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef'
const USDCX_TESTNET =
  'decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61'
const CBTC_MAINNET =
  'cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262'
const CBTC_TESTNET =
  'cbtc-network::12201b1741b63e2494e4214cf0bedc3d5a224da53b3bf4d76dba468f8e97eb15508f'
const DSO_MAINNET = 'DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc'
const DSO_TESTNET = 'DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337'

export const REAL_PROFILES: Record<RealNetwork, RealProfile> = {
  mainnet: {
    network: 'mainnet',
    instruments: {
      usdcx: { admin: USDCX_MAINNET, id: 'USDCx' },
      cc: { admin: DSO_MAINNET, id: 'Amulet' },
      cbtc: { admin: CBTC_MAINNET, id: 'CBTC' },
    },
    registries: {
      usdcx: registrar(DA_MAINNET, USDCX_MAINNET),
      cc: 'https://scan.sv-1.global.canton.network.sync.global',
      cbtc: registrar(DA_MAINNET, CBTC_MAINNET),
    },
    utilitiesBackend: DA_MAINNET,
    bridge: {
      utilityOperator:
        'auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e',
      bridgeOperator:
        'Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f',
    },
    xreserve: {
      chainId: 1,
      contract: '0x8888888199b2df864bf678259607d6d5ebb4e3ce',
      usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      cantonDomain: CANTON_DOMAIN,
    },
  },
  testnet: {
    network: 'testnet',
    instruments: {
      usdcx: { admin: USDCX_TESTNET, id: 'USDCx' },
      cc: { admin: DSO_TESTNET, id: 'Amulet' },
      cbtc: { admin: CBTC_TESTNET, id: 'CBTC' },
    },
    registries: {
      usdcx: registrar(DA_TESTNET, USDCX_TESTNET),
      cc: 'https://scan.sv-1.test.global.canton.network.sync.global',
      cbtc: registrar(DA_TESTNET, CBTC_TESTNET),
    },
    utilitiesBackend: DA_TESTNET,
    bridge: {
      utilityOperator:
        'DigitalAsset-UtilityOperator::12202679f2bbe57d8cba9ef3cee847ac8239df0877105ab1f01a77d47477fdce1204',
      bridgeOperator:
        'Bridge-Operator::12209d011ce250de439fefc35d16d1ab9d56fb99ccb24c18d798efb22352d533bcdb',
    },
    xreserve: {
      chainId: 11155111,
      contract: '0x008888878f94c0d87defdf0b07f46b93c1934442',
      usdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      cantonDomain: CANTON_DOMAIN,
    },
  },
}

export const sameInstrument = (a: Instrument, b: Instrument) => a.admin === b.admin && a.id === b.id

/**
 * Deployment under profile real: deployment.json instruments are exactly the network's instruments,
 * ETH and SOL are absent, the EVM custodian is set. Otherwise startup is refused (fail-closed).
 */
export function assertDeploymentMatchesProfile(
  d: {
    usdcx: Instrument
    cc: Instrument
    cbtc: Instrument
    eth?: Instrument | undefined
    sol?: Instrument | undefined
    evm?: { custody: string } | undefined
  },
  p: RealProfile,
) {
  for (const slot of ['usdcx', 'cc', 'cbtc'] as const)
    if (!sameInstrument(d[slot], p.instruments[slot]))
      throw new Error(
        `ASSET_PROFILE=real: deployment ${slot} is ${d[slot].admin}/${d[slot].id}, the ${p.network} instrument is ${p.instruments[slot].admin}/${p.instruments[slot].id}`,
      )
  if (d.eth || d.sol)
    throw new Error(
      'ASSET_PROFILE=real: ETH and SOL have no Canton asset, remove them from deployment.json',
    )
  if (!d.evm?.custody) throw new Error('ASSET_PROFILE=real needs deployment.json evm.custody')
}

/** Round down to `digits` decimal places (as a string, no float): USDCx burn uses 6. */
export function floorDecimal(amount: string, digits: number): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim())
  if (!m) throw new Error(`not a decimal amount: ${amount}`)
  const int = m[1]!.replace(/^0+(?=\d)/, '')
  const frac = (m[2] ?? '').slice(0, digits).replace(/0+$/, '')
  return frac ? `${int}.${frac}` : int
}

/** USDC amount in token units (6 decimals) → decimal string. */
export function fromUnits(units: bigint, decimals: number): string {
  const neg = units < 0n
  const s = (neg ? -units : units).toString().padStart(decimals + 1, '0')
  const int = s.slice(0, -decimals) || '0'
  const frac = s.slice(-decimals).replace(/0+$/, '')
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`
}

/** Decimal string → token units; more than `decimals` decimals gives null (no rounding). */
export function toUnits(amount: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim())
  if (!m) return null
  const frac = (m[2] ?? '').replace(/0+$/, '')
  if (frac.length > decimals) return null
  return BigInt(m[1]! + frac.padEnd(decimals, '0'))
}
