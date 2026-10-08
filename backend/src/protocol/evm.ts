/**
 * EVM wallet accounts (0.5.0, ADR-004). The user has MetaMask, Coinbase Wallet or another EVM
 * wallet and no Canton party. Their account is a subaccount of the protocol's custodial party: the
 * backend builds the same pool command as for a Canton party, wraps it into Pool_EvmExecute and
 * returns the text for personal_sign. The backend submits the signed operation as the custodian,
 * and the contract verifies the signature (Lending.Evm): without it the account does not move.
 *
 * API login is a signature over a login message (like Sign-In with Ethereum), off-ledger.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  type EvmAction,
  evmLoginMessage,
  evmMessage,
  type EvmMessageFields,
  type EvmWalletAction,
  type EvmWalletMessageFields,
  isEvmAddress,
  type PreparedCommand as SealedCommand,
} from '@lending/shared'
import { floorDecimal, USDC_DECIMALS } from '../assets/profiles.ts'
import {
  type Hex,
  hashMessage,
  parseSignature,
  recoverMessageAddress,
  recoverPublicKey,
} from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import type { Deployment, Instrument, MarketId } from '../deployment.ts'
import type { Command, DisclosedContract, LedgerClient } from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import {
  type AmountInput,
  type CommandBuilder,
  CommandError,
  type PreparedCommand,
} from './commands.ts'
import { dec } from './math.ts'
import type { Reader } from './reader.ts'

/** Operation signature expiry: the contract accepts at most 30 minutes ahead. */
export const EVM_SIGNATURE_TTL_MS = 10 * 60_000

/** secp256k1 order and its half (EIP-2): the contract rejects s above the half. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const HALF_N = N / 2n

/** EVM wallet operations (K2): repay is supply that needs a debt; "max" means all. */
export type EvmOp =
  | { op: 'supply'; amount: AmountInput }
  | { op: 'repay'; amount: AmountInput }
  | { op: 'withdraw'; amount: AmountInput }
  | { op: 'borrow'; amount: AmountInput }
  | { op: 'deposit-collateral'; marketId: MarketId; amount: AmountInput }
  | { op: 'withdraw-collateral'; marketId: MarketId; amount: AmountInput }

/** Prepared operation: the unsigned command and everything the message text is built from. */
export interface EvmPrepared {
  prepared: PreparedCommand
  evm: EvmMessageFields
  message: string
}

/**
 * Wallet operations with real assets (0.6.0, Pool_EvmWalletExecute): withdrawal to a Canton
 * party and a request to withdraw USDCx to Ethereum.
 */
export type EvmWalletOp =
  | { op: 'transfer-out'; instrument: Instrument; amount: string; receiver: string }
  | { op: 'redeem'; amount: string; ethAddress: string }

export interface EvmWalletPrepared {
  prepared: PreparedCommand
  evm: EvmWalletMessageFields
  message: string
  /** redeem: the requested amount, if it had to be rounded down to 6 decimals */
  requestedAmount?: string
}

export class EvmSignatureError extends Error {}

/** Wallet signature (65 bytes hex) → key and (r, s) in the contract's form. */
export async function recoverEvmSignature(message: string, signature: string) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new EvmSignatureError('signature must be 65 bytes of hex')
  const sig = signature as Hex
  const publicKey = await recoverPublicKey({ hash: hashMessage(message), signature: sig })
  const address = publicKeyToAddress(publicKey).toLowerCase()
  const p = parseSignature(sig)
  let s = BigInt(p.s)
  // The same signature in the lower half of the order: (r, n − s) verifies with the same key
  if (s > HALF_N) s = N - s
  return {
    address,
    publicKey: publicKey.slice(4).toLowerCase(),
    r: p.r.slice(2).toLowerCase().padStart(64, '0'),
    s: s.toString(16).padStart(64, '0'),
  }
}

/** Address of the signer of the login message. */
export async function evmSigner(message: string, signature: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new EvmSignatureError('signature must be 65 bytes of hex')
  return (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase()
}

const extraArgs = { context: { values: {} }, meta: { values: {} } }

export function createEvm(
  d: Deployment,
  ledger: LedgerClient,
  reader: Reader,
  commands: CommandBuilder,
  /** enabled: false means EVM accounts are off (EVM_WALLETS), as with Loop; on by default */
  opts: { enabled?: boolean; now?: () => number } = {},
) {
  const now = opts.now ?? Date.now
  const custody = (opts.enabled ?? true) ? d.evm?.custody : undefined
  const need = () => {
    if (!custody) throw new CommandError('EVM wallets are not enabled on this deployment')
    return custody
  }

  /** The address's wallet; if none, open an account (EvmDirectory_Open by the operator). */
  async function ensureAccount(address: string) {
    need()
    if (!isEvmAddress(address)) throw new CommandError('not a lowercase 0x address')
    const existing = await reader.evmWallet(address)
    if (existing) return existing
    const directory = await reader.evmDirectory()
    if (!directory) throw new CommandError('EVM accounts are not set up: no EvmDirectory')
    await ledger.submit(
      [d.operator],
      [
        {
          ExerciseCommand: {
            templateId: TEMPLATES.evmDirectory,
            contractId: directory.contractId,
            choice: 'EvmDirectory_Open',
            choiceArgument: { address },
          },
        },
      ],
      [],
      [],
      // Idempotent by address: a repeated login will not open a second account
      { commandId: `evm-open-${address}` },
    )
    const opened = await reader.evmWallet(address)
    if (!opened) throw new CommandError('EVM account was not opened, try again')
    return opened
  }

  /** User operation → unsigned command and text for personal_sign. */
  async function prepare(address: string, o: EvmOp): Promise<EvmPrepared> {
    const party = need()
    const wallet = await reader.evmWallet(address)
    if (!wallet) throw new CommandError('Sign in with your wallet first')
    const who = { key: address, party }
    const s = await reader.snapshot()
    const debt = s.config.payload.params.debtInstrument
    const balance = (i: { admin: string; id: string }) =>
      dec(wallet.payload.balances.find(([k]) => k.admin === i.admin && k.id === i.id)?.[1] ?? '0')
    const expiresAt = new Date(Math.floor((now() + EVM_SIGNATURE_TTL_MS) / 1000) * 1000)
    const signature = {
      publicKey: '',
      r: '',
      s: '',
      nonce: wallet.payload.nonce,
      expiresAt: expiresAt.toISOString(),
    }
    const base: PreparedCommand =
      o.op === 'supply'
        ? await commands.supply(who, o.amount)
        : o.op === 'repay'
          ? await commands.repay(who, o.amount)
          : o.op === 'withdraw'
            ? await commands.withdraw(who, o.amount)
            : o.op === 'borrow'
              ? await commands.borrow(who, o.amount)
              : o.op === 'deposit-collateral'
                ? await commands.depositCollateral(who, o.marketId, o.amount)
                : await commands.withdrawCollateral(who, o.marketId, o.amount)
    const ex = exercise(base)
    const a = ex.choiceArgument as Record<string, unknown> & { amount: string; full?: boolean }
    const full = a.full === true
    const marketId = a.marketId as MarketId | undefined
    // Payment from the wallet: the address's share of the custodian's holdings must cover it
    const pays =
      o.op === 'supply' || o.op === 'repay'
        ? debt
        : o.op === 'deposit-collateral'
          ? s.marketParams.get(o.marketId)?.collateralInstrument
          : undefined
    if (pays && balance(pays).lt(a.amount))
      throw new CommandError(
        `Your wallet holds ${balance(pays).toFixed(10, 1)} ${pays.id}, less than ${a.amount}`,
      )
    const tagged: Record<EvmOp['op'], [string, EvmAction, Record<string, unknown>]> = {
      supply: ['EvmSupply', { kind: 'supply', amount: a.amount, full }, { amount: a.amount, full }],
      repay: ['EvmSupply', { kind: 'supply', amount: a.amount, full }, { amount: a.amount, full }],
      withdraw: [
        'EvmWithdraw',
        { kind: 'withdraw', amount: a.amount, full },
        { amount: a.amount, full },
      ],
      borrow: ['EvmBorrow', { kind: 'borrow', amount: a.amount }, { amount: a.amount }],
      'deposit-collateral': [
        'EvmDepositCollateral',
        { kind: 'deposit-collateral', marketId: marketId!, amount: a.amount },
        { marketId, amount: a.amount },
      ],
      'withdraw-collateral': [
        'EvmWithdrawCollateral',
        { kind: 'withdraw-collateral', marketId: marketId!, amount: a.amount },
        { marketId, amount: a.amount },
      ],
    }
    const [tag, action, value] = tagged[o.op]
    const command: Command = {
      ExerciseCommand: {
        templateId: TEMPLATES.pool,
        contractId: ex.contractId,
        choice: 'Pool_EvmExecute',
        choiceArgument: {
          custody: party,
          configCid: a.configCid,
          pauseCid: s.pause.contractId,
          walletCid: wallet.contractId,
          accountCid: a.accountCid,
          action: { tag, value },
          signature,
          prices: a.prices ?? { collateralFeedCids: [], debtFeedCid: null, attestationCids: [] },
          transfer: a.payment ?? a.payout,
        },
      },
    }
    const evm: EvmMessageFields = {
      network: wallet.payload.network,
      operator: d.operator,
      address,
      action,
      debt: debt.id,
      nonce: Number(wallet.payload.nonce),
      expiresAt: expiresAt.toISOString(),
    }
    return {
      prepared: { ...base, actAs: [party], commands: [command] },
      evm,
      message: evmMessage(evm),
    }
  }

  /**
   * Submit a signed operation as the custodian. The command and message fields come from the server
   * seal (checks the route); the signature must be by the account address's key.
   */
  async function submit(p: SealedBody, signature: string) {
    const party = need()
    const message = evmMessage(p.evm)
    const sig = await recoverEvmSignature(message, signature)
    if (sig.address !== p.evm.address)
      throw new EvmSignatureError('the signature is from another wallet than this account')
    const commandsWithSig = p.commands.map((c) => {
      const ex = (c as { ExerciseCommand?: { choiceArgument: Record<string, unknown> } })
        .ExerciseCommand
      if (!ex) return c
      const current = ex.choiceArgument.signature as Record<string, unknown>
      return {
        ExerciseCommand: {
          ...ex,
          choiceArgument: {
            ...ex.choiceArgument,
            signature: { ...current, publicKey: sig.publicKey, r: sig.r, s: sig.s },
          },
        },
      }
    }) as Command[]
    const r = await ledger.submit([party], commandsWithSig, p.disclosedContracts as never, [], {
      // Idempotent by address and nonce: the ledger drops a repeat of the same signature as a
      // duplicate
      commandId: `evm-${p.evm.address}-${p.evm.nonce}`,
    })
    return { updateId: r.updateId }
  }

  /**
   * Faucet: the registry offers a transfer to the custodian, the custodian credits it to the
   * address's wallet.
   */
  async function receive(address: string, offerCid: string) {
    const party = need()
    const wallet = await reader.evmWallet(address)
    if (!wallet) throw new CommandError('Sign in with your wallet first')
    await ledger.submit(
      [party],
      [
        {
          ExerciseCommand: {
            templateId: TEMPLATES.evmWallet,
            contractId: wallet.contractId,
            choice: 'EvmWallet_Receive',
            choiceArgument: { instructionCid: offerCid, extraArgs },
          },
        },
      ],
      [],
      [],
      { commandId: `evm-receive-${offerCid.slice(0, 64)}` },
    )
  }

  /**
   * Withdrawal to a Canton party or a request to withdraw USDCx to Ethereum (0.6.0): unsigned
   * Pool_EvmWalletExecute command and text for personal_sign. The redeem amount is rounded
   * down to 6 decimals (xReserve burn); the exact amount goes into the response.
   */
  async function prepareWalletOp(address: string, o: EvmWalletOp): Promise<EvmWalletPrepared> {
    const party = need()
    const wallet = await reader.evmWallet(address)
    if (!wallet) throw new CommandError('Sign in with your wallet first')
    const balanceOf = (i: Instrument) =>
      dec(wallet.payload.balances.find(([k]) => k.admin === i.admin && k.id === i.id)?.[1] ?? '0')
    const expiresAt = new Date(Math.floor((now() + EVM_SIGNATURE_TTL_MS) / 1000) * 1000)
    const signature = {
      publicKey: '',
      r: '',
      s: '',
      nonce: wallet.payload.nonce,
      expiresAt: expiresAt.toISOString(),
    }
    let action: EvmWalletAction
    let tagged: { tag: string; value: Record<string, unknown> }
    let transfer: unknown = null
    let disclosed: DisclosedContract[]
    let requestedAmount: string | undefined
    let s: Awaited<ReturnType<Reader['snapshot']>>
    if (o.op === 'transfer-out') {
      if (o.receiver === party) throw new CommandError('The receiver must not be the custody party')
      const amount = dec(o.amount)
      if (amount.lte(0)) throw new CommandError('Enter an amount above zero')
      const have = balanceOf(o.instrument)
      if (have.lt(amount))
        throw new CommandError(
          `Your wallet holds ${have.toFixed(10, 1)} ${o.instrument.id}, less than ${o.amount}`,
        )
      const t = await commands.custodyTransfer(party, o.instrument, o.amount, o.receiver)
      s = t.snapshot
      transfer = t.args
      disclosed = t.disclosed
      action = {
        kind: 'transfer-out',
        symbol: o.instrument.id,
        amount: o.amount,
        receiver: o.receiver,
      }
      tagged = {
        tag: 'EvmTransferOut',
        value: { instrumentId: o.instrument, amount: o.amount, receiver: o.receiver },
      }
    } else {
      s = await reader.snapshot()
      const debt = s.config.payload.params.debtInstrument
      // xReserve burns at most 6 decimals: round down so as not to debit more than requested
      const amount = floorDecimal(o.amount, USDC_DECIMALS)
      if (dec(amount).lte(0))
        throw new CommandError('USDCx goes to Ethereum in amounts of at least 0.000001')
      if (dec(amount).cmp(dec(o.amount)) !== 0) requestedAmount = o.amount
      const have = balanceOf(debt)
      if (have.lt(amount))
        throw new CommandError(
          `Your wallet holds ${have.toFixed(10, 1)} USDCx, less than ${amount}`,
        )
      const requestId = randomUUID()
      action = { kind: 'redeem', amount, ethAddress: o.ethAddress, requestId }
      tagged = { tag: 'EvmRedeem', value: { amount, ethAddress: o.ethAddress, requestId } }
      disclosed = [
        toDisclosedOf(s.config),
        toDisclosedOf(s.pool),
        ...(s.featuredAppRight ? [toDisclosedOf(s.featuredAppRight)] : []),
      ]
    }
    const command: Command = {
      ExerciseCommand: {
        templateId: TEMPLATES.pool,
        contractId: s.pool.contractId,
        choice: 'Pool_EvmWalletExecute',
        choiceArgument: {
          custody: party,
          configCid: s.config.contractId,
          walletCid: wallet.contractId,
          action: tagged,
          signature,
          transfer,
        },
      },
    }
    const evm: EvmWalletMessageFields = {
      network: wallet.payload.network,
      operator: d.operator,
      address,
      action,
      debt: s.config.payload.params.debtInstrument.id,
      nonce: Number(wallet.payload.nonce),
      expiresAt: expiresAt.toISOString(),
    }
    return {
      prepared: { actAs: [party], commands: [command], disclosedContracts: disclosed },
      evm,
      message: evmMessage(evm),
      ...(requestedAmount ? { requestedAmount } : {}),
    }
  }

  /**
   * Credit an incoming transfer with memo `lending:evm:<address>` (0.6.0,
   * EvmWallet_ReceiveAttributed): the contract checks the reason. Idempotent by instruction cid.
   */
  async function receiveAttributed(
    address: string,
    instructionCid: string,
    accept: { extraArgs: unknown; disclosed: DisclosedContract[] },
  ) {
    const party = need()
    const wallet = await reader.evmWallet(address)
    if (!wallet) throw new CommandError(`no EVM wallet for ${address}`)
    return ledger.submit(
      [party],
      [
        {
          ExerciseCommand: {
            templateId: TEMPLATES.evmWallet,
            contractId: wallet.contractId,
            choice: 'EvmWallet_ReceiveAttributed',
            choiceArgument: { instructionCid, extraArgs: accept.extraArgs },
          },
        },
      ],
      accept.disclosed,
      [],
      { commandId: `evm-deposit-${sha(instructionCid)}` },
    )
  }

  /**
   * Reclaim a wallet withdrawal the receiver did not accept before executeBefore (0.6.0,
   * EvmWallet_ReclaimTransferOut): holdings return to the custodian, the amount to the wallet.
   * Idempotent by instruction cid.
   */
  async function reclaimTransferOut(
    address: string,
    instructionCid: string,
    withdraw: { extraArgs: unknown; disclosed: DisclosedContract[] },
  ) {
    const party = need()
    const wallet = await reader.evmWallet(address)
    if (!wallet) throw new CommandError(`no EVM wallet for ${address}`)
    return ledger.submit(
      [party],
      [
        {
          ExerciseCommand: {
            templateId: TEMPLATES.evmWallet,
            contractId: wallet.contractId,
            choice: 'EvmWallet_ReclaimTransferOut',
            choiceArgument: { instructionCid, extraArgs: withdraw.extraArgs },
          },
        },
      ],
      withdraw.disclosed,
      [],
      { commandId: `evm-reclaim-${sha(instructionCid)}` },
    )
  }

  return {
    enabled: !!custody,
    custody,
    ensureAccount,
    reclaimTransferOut,
    prepare,
    prepareWalletOp,
    submit,
    receive,
    receiveAttributed,
    loginMessage: evmLoginMessage,
  }
}

/** Seal body of an EVM operation: the command and message fields. */
export interface SealedBody {
  actAs: string[]
  commands: unknown[]
  disclosedContracts: unknown[]
  evm: EvmMessageFields | EvmWalletMessageFields
}

export const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 40)

const toDisclosedOf = (c: {
  templateId: string
  contractId: string
  createdEventBlob: string
  synchronizerId: string
}): DisclosedContract => ({
  templateId: c.templateId,
  contractId: c.contractId,
  createdEventBlob: c.createdEventBlob,
  synchronizerId: c.synchronizerId,
})

export type Evm = ReturnType<typeof createEvm>
export type { SealedCommand }

function exercise(p: PreparedCommand) {
  const c = p.commands[0] as { ExerciseCommand?: { contractId: string; choiceArgument: unknown } }
  if (!c?.ExerciseCommand) throw new Error('expected an exercise command')
  return c.ExerciseCommand
}
