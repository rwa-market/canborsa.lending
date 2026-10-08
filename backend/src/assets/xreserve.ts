/**
 * Verifying a USDC deposit to xReserve on Ethereum (seam 2): the user called
 * `depositToRemote` from MetaMask themselves, with the custodian party as recipient. The backend
 * uses ETH_RPC_URL to check the transaction before crediting, taking nothing from the request on
 * trust:
 *
 * - the RPC network is the profile's (eth_chainId), the receipt succeeded, enough confirmations;
 * - tx.from is the session address, tx.to is the profile's xReserve contract;
 * - calldata is depositToRemote (ABI Circle quickstart [V]): Canton domain 10001, token is the
 *   profile's USDC, remoteRecipient = keccak256(utf8(custody)), hookData = utf8(custody);
 * - the logs have a USDC Transfer from the address to xReserve for the same amount (ERC-20);
 * - if XRESERVE_DEPOSIT_EVENT is set, also a log of that event from xReserve (TODO(config)).
 *
 * JSON-RPC is a plain fetch: three methods, no client and no retries within a request.
 */
import {
  type Abi,
  decodeEventLog,
  decodeFunctionData,
  type Hex,
  hexToString,
  keccak256,
  parseAbiItem,
  stringToBytes,
  toEventSelector,
} from 'viem'
import type { XreserveProfile } from './profiles.ts'

export const XRESERVE_ABI = [
  {
    type: 'function',
    name: 'depositToRemote',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'value', type: 'uint256' },
      { name: 'remoteDomain', type: 'uint32' },
      { name: 'remoteRecipient', type: 'bytes32' },
      { name: 'localToken', type: 'address' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

/** keccak256("Transfer(address,address,uint256)"): the ERC-20 event. */
export const ERC20_TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)')

export type ClaimErrorCode =
  | 'TX_NOT_FOUND'
  | 'TX_PENDING'
  | 'TX_FAILED'
  | 'WRONG_CHAIN'
  | 'WRONG_SENDER'
  | 'NOT_XRESERVE'
  | 'WRONG_RECIPIENT'
  | 'WRONG_TOKEN'
  | 'WRONG_DOMAIN'
  | 'NO_DEPOSIT_LOG'
  | 'AMOUNT_MISMATCH'
  | 'ALREADY_CLAIMED'
  | 'CLAIM_IN_PROGRESS'
  | 'NOT_ATTESTED'
  | 'RPC_UNAVAILABLE'
  | 'NOT_ONBOARDED'
  | 'LEDGER_BUSY'

const STATUS: Record<ClaimErrorCode, number> = {
  TX_NOT_FOUND: 404,
  TX_PENDING: 409,
  TX_FAILED: 422,
  WRONG_CHAIN: 503,
  WRONG_SENDER: 403,
  NOT_XRESERVE: 422,
  WRONG_RECIPIENT: 422,
  WRONG_TOKEN: 422,
  WRONG_DOMAIN: 422,
  NO_DEPOSIT_LOG: 422,
  AMOUNT_MISMATCH: 422,
  ALREADY_CLAIMED: 409,
  CLAIM_IN_PROGRESS: 409,
  NOT_ATTESTED: 409,
  RPC_UNAVAILABLE: 503,
  NOT_ONBOARDED: 503,
  LEDGER_BUSY: 503,
}

export class ClaimError extends Error {
  readonly status: number
  constructor(
    readonly code: ClaimErrorCode,
    message: string,
  ) {
    super(message)
    this.status = STATUS[code]
  }
}

interface RpcTx {
  hash: string
  from: string
  to: string | null
  input: string
  blockNumber: string | null
}
interface RpcLog {
  address: string
  topics: string[]
  data: string
}
interface RpcReceipt {
  status: string
  blockNumber: string
  logs: RpcLog[]
}

export interface EthRpc {
  chainId(): Promise<number>
  blockNumber(): Promise<bigint>
  transaction(hash: string): Promise<RpcTx | null>
  receipt(hash: string): Promise<RpcReceipt | null>
}

/** JSON-RPC over HTTP. The URL may carry the provider key: it never goes into logs or errors. */
export function httpEthRpc(opts: {
  url: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): EthRpc {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a))
  let id = 0
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response
    try {
      res = await doFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      })
    } catch (err) {
      throw new ClaimError(
        'RPC_UNAVAILABLE',
        `Ethereum RPC did not answer (${(err as Error).name})`,
      )
    }
    if (!res.ok) throw new ClaimError('RPC_UNAVAILABLE', `Ethereum RPC: HTTP ${res.status}`)
    const body = (await res.json().catch(() => null)) as {
      result?: T
      error?: { message?: string }
    } | null
    if (!body || body.error)
      throw new ClaimError('RPC_UNAVAILABLE', `Ethereum RPC ${method} failed`)
    return body.result as T
  }
  return {
    chainId: async () => Number(BigInt(await call<string>('eth_chainId', []))),
    blockNumber: async () => BigInt(await call<string>('eth_blockNumber', [])),
    transaction: (hash) => call<RpcTx | null>('eth_getTransactionByHash', [hash]),
    receipt: (hash) => call<RpcReceipt | null>('eth_getTransactionReceipt', [hash]),
  }
}

export interface VerifiedDeposit {
  txHash: string
  from: string
  /** Deposit amount in USDC units (6 decimals) */
  value: bigint
  /** Fee ceiling from calldata, USDC units */
  maxFee: bigint
  blockNumber: bigint
}

const pad32 = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`

/** Verify a deposit; any mismatch gives a ClaimError with a code, no credit. */
export async function verifyXreserveDeposit(
  rpc: EthRpc,
  p: {
    txHash: string
    address: string
    custody: string
    xreserve: XreserveProfile
    minConfirmations: number
    /** TODO(config): `event …` from XRESERVE_DEPOSIT_EVENT; if absent, check without it */
    depositEvent?: string | undefined
  },
): Promise<VerifiedDeposit> {
  const chainId = await rpc.chainId()
  if (chainId !== p.xreserve.chainId)
    throw new ClaimError(
      'WRONG_CHAIN',
      `ETH_RPC_URL serves chain ${chainId}, the profile needs ${p.xreserve.chainId}`,
    )
  const [tx, receipt] = await Promise.all([rpc.transaction(p.txHash), rpc.receipt(p.txHash)])
  if (!tx) throw new ClaimError('TX_NOT_FOUND', 'No such transaction on Ethereum')
  if (!receipt || !tx.blockNumber)
    throw new ClaimError('TX_PENDING', 'The transaction is not in a block yet, try again later')
  if (BigInt(receipt.status) !== 1n)
    throw new ClaimError('TX_FAILED', 'The transaction failed on Ethereum')
  const head = await rpc.blockNumber()
  const confirmations = head - BigInt(receipt.blockNumber) + 1n
  if (confirmations < BigInt(p.minConfirmations))
    throw new ClaimError(
      'TX_PENDING',
      `The deposit has ${confirmations} of ${p.minConfirmations} confirmations, try again later`,
    )
  if (tx.from.toLowerCase() !== p.address)
    throw new ClaimError('WRONG_SENDER', 'The transaction was sent from another wallet')
  if (tx.to?.toLowerCase() !== p.xreserve.contract)
    throw new ClaimError('NOT_XRESERVE', 'The transaction is not a call to xReserve')
  let args: readonly [bigint, number, Hex, string, bigint, Hex]
  try {
    const decoded = decodeFunctionData({ abi: XRESERVE_ABI, data: tx.input as Hex })
    args = decoded.args
  } catch {
    throw new ClaimError('NOT_XRESERVE', 'The transaction is not an xReserve depositToRemote')
  }
  const [value, remoteDomain, remoteRecipient, localToken, maxFee, hookData] = args
  if (remoteDomain !== p.xreserve.cantonDomain)
    throw new ClaimError('WRONG_DOMAIN', 'The deposit goes to another chain than Canton')
  if (localToken.toLowerCase() !== p.xreserve.usdc)
    throw new ClaimError('WRONG_TOKEN', 'The deposit is not USDC')
  if (remoteRecipient.toLowerCase() !== keccak256(stringToBytes(p.custody)))
    throw new ClaimError('WRONG_RECIPIENT', 'The deposit is addressed to another Canton party')
  let hookParty: string
  try {
    hookParty = hexToString(hookData)
  } catch {
    hookParty = ''
  }
  if (hookParty !== p.custody)
    throw new ClaimError('WRONG_RECIPIENT', 'The deposit hook data names another Canton party')
  if (value <= 0n) throw new ClaimError('AMOUNT_MISMATCH', 'The deposit amount is zero')
  const transfer = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === p.xreserve.usdc &&
      l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
      l.topics[1]?.toLowerCase() === pad32(p.address) &&
      l.topics[2]?.toLowerCase() === pad32(p.xreserve.contract) &&
      BigInt(l.data) === value,
  )
  if (!transfer)
    throw new ClaimError('NO_DEPOSIT_LOG', 'No USDC transfer to xReserve in the transaction')
  if (p.depositEvent) {
    const abi = [parseAbiItem(p.depositEvent)] as Abi
    const found = receipt.logs.some((l) => {
      if (l.address.toLowerCase() !== p.xreserve.contract) return false
      try {
        decodeEventLog({ abi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] })
        return true
      } catch {
        return false
      }
    })
    if (!found)
      throw new ClaimError('NO_DEPOSIT_LOG', 'No xReserve deposit event in the transaction')
  }
  return {
    txHash: p.txHash,
    from: tx.from.toLowerCase(),
    value,
    maxFee,
    blockNumber: BigInt(receipt.blockNumber),
  }
}
