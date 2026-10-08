/**
 * Loop wallet accounts (lending-core 0.7.0). Loop does not run third-party DARs: a Loop user does
 * not call protocol choices directly. Their account is a LoopWallet under the custodial party (the
 * same as for EVM accounts, deployment.json evm.custody), like an EVM wallet (ADR-004).
 *
 * Difference from EVM: Daml 3.5 has no Ed25519 verification, so the operation signature is verified
 * by the backend (loop-crypto.ts) with the key from LoopWallet.publicKey, while the contract checks
 * the nonce and expiry and stores the signed text in the event for audit. Trust in the backend is
 * higher here than on the EVM path: the signature is not re-verified on the ledger.
 */
import {
  type LoopAction,
  loopMessage,
  type LoopMessageFields,
  loopSubject,
  type EvmAction,
} from '@lending/shared'
import type { Deployment, Instrument, MarketId } from '../deployment.ts'
import type { Command, DisclosedContract, LedgerClient } from '../ledger/client.ts'
import { TEMPLATES } from '../ledger/ids.ts'
import {
  type AmountInput,
  type CommandBuilder,
  CommandError,
  type PreparedCommand,
} from './commands.ts'
import { sha } from './evm.ts'
import {
  bindsParty,
  parseLoopPublicKey,
  type SignatureMatch,
  verifyLoopSignature,
} from './loop-crypto.ts'
import { dec } from './math.ts'
import type { Reader } from './reader.ts'

/** Operation signature expiry, as for EVM. */
export const LOOP_SIGNATURE_TTL_MS = 10 * 60_000

/** Loop operations (K2): repay is supply that needs a debt; "max" means all. */
export type LoopOp =
  | { op: 'supply'; amount: AmountInput }
  | { op: 'repay'; amount: AmountInput }
  | { op: 'withdraw'; amount: AmountInput }
  | { op: 'borrow'; amount: AmountInput }
  | { op: 'deposit-collateral'; marketId: MarketId; amount: AmountInput }
  | { op: 'withdraw-collateral'; marketId: MarketId; amount: AmountInput }
  | { op: 'transfer-out'; instrument: Instrument; amount: string; receiver: string }

export interface LoopPrepared {
  prepared: PreparedCommand
  loop: LoopMessageFields
  message: string
}

/** Seal body of a Loop operation: the command and message fields. */
export interface LoopSealedBody {
  actAs: string[]
  commands: unknown[]
  disclosedContracts: unknown[]
  loop: LoopMessageFields
}

/** Signature did not match (401). */
export class LoopSignatureError extends Error {}

/** Rejection with a code: nonce, expiry, key change. */
export class LoopError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const extraArgs = { context: { values: {} }, meta: { values: {} } }

export function createLoop(
  d: Deployment,
  ledger: LedgerClient,
  reader: Reader,
  commands: CommandBuilder,
  opts: { enabled?: boolean; now?: () => number } = {},
) {
  const now = opts.now ?? Date.now
  const custody = (opts.enabled ?? true) ? d.evm?.custody : undefined
  const need = () => {
    if (!custody) throw new CommandError('Loop wallets are not enabled on this deployment')
    return custody
  }

  async function walletOf(party: string) {
    const w = await reader.loopWallet(party)
    if (!w) throw new CommandError('Sign in with your Loop wallet first')
    return w
  }

  /**
   * The party's wallet; if none, open an account (LoopDirectory_Open by the operator). The key is
   * the canonical hex already bound to the party by fingerprint. A wallet with a different key is
   * rejected: signatures are verified with the key from LoopWallet.
   */
  async function ensureAccount(party: string, publicKey: string) {
    need()
    const existing = await reader.loopWallet(party)
    if (existing) {
      if (existing.payload.publicKey !== publicKey)
        throw new LoopError(
          409,
          'LOOP_KEY_CHANGED',
          'This Loop account is registered with another key; contact support',
        )
      return existing
    }
    const directory = await reader.loopDirectory()
    if (!directory) throw new CommandError('Loop accounts are not set up: no LoopDirectory')
    await ledger.submit(
      [d.operator],
      [
        {
          ExerciseCommand: {
            templateId: TEMPLATES.loopDirectory,
            contractId: directory.contractId,
            choice: 'LoopDirectory_Open',
            choiceArgument: { party, publicKey },
          },
        },
      ],
      [],
      [],
      // Idempotent by party: a repeated login will not open a second account
      { commandId: `loop-open-${sha(party)}` },
    )
    const opened = await reader.loopWallet(party)
    if (!opened) throw new CommandError('Loop account was not opened, try again')
    return opened
  }

  /** Operation → unsigned Pool_LoopWalletExecute and text for signMessage. */
  async function prepare(party: string, o: LoopOp): Promise<LoopPrepared> {
    const cust = need()
    const wallet = await walletOf(party)
    const who = { key: loopSubject(party), party: cust }
    const balance = (i: Instrument) =>
      dec(wallet.payload.balances.find(([k]) => k.admin === i.admin && k.id === i.id)?.[1] ?? '0')
    const expiresAt = new Date(Math.floor((now() + LOOP_SIGNATURE_TTL_MS) / 1000) * 1000)
    let action: LoopAction
    let tagged: { tag: string; value: Record<string, unknown> }
    let pool: string
    let rest: Record<string, unknown>
    let disclosed: DisclosedContract[]
    let debtId: string

    if (o.op === 'transfer-out') {
      if (o.receiver === cust) throw new CommandError('The receiver must not be the custody party')
      const amount = dec(o.amount)
      if (amount.lte(0)) throw new CommandError('Enter an amount above zero')
      const have = balance(o.instrument)
      if (have.lt(amount))
        throw new CommandError(
          `Your wallet holds ${have.toFixed(10, 1)} ${o.instrument.id}, less than ${o.amount}`,
        )
      const t = await commands.custodyTransfer(cust, o.instrument, o.amount, o.receiver)
      const s = t.snapshot
      debtId = s.config.payload.params.debtInstrument.id
      pool = s.pool.contractId
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
      rest = {
        configCid: s.config.contractId,
        pauseCid: s.pause.contractId,
        accountCid: null,
        prices: { collateralFeedCids: [], debtFeedCid: null, attestationCids: [] },
        transfer: t.args,
      }
    } else {
      const s = await reader.snapshot()
      const debt = s.config.payload.params.debtInstrument
      debtId = debt.id
      const base =
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
      // Payment from the wallet: the party's share of the custodian's holdings must cover it
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
      const m = marketId!
      const table: Record<typeof o.op, [string, EvmAction, Record<string, unknown>]> = {
        supply: [
          'EvmSupply',
          { kind: 'supply', amount: a.amount, full },
          { amount: a.amount, full },
        ],
        repay: [
          'EvmSupply',
          { kind: 'supply', amount: a.amount, full },
          { amount: a.amount, full },
        ],
        withdraw: [
          'EvmWithdraw',
          { kind: 'withdraw', amount: a.amount, full },
          { amount: a.amount, full },
        ],
        borrow: ['EvmBorrow', { kind: 'borrow', amount: a.amount }, { amount: a.amount }],
        'deposit-collateral': [
          'EvmDepositCollateral',
          { kind: 'deposit-collateral', marketId: m, amount: a.amount },
          { marketId: m, amount: a.amount },
        ],
        'withdraw-collateral': [
          'EvmWithdrawCollateral',
          { kind: 'withdraw-collateral', marketId: m, amount: a.amount },
          { marketId: m, amount: a.amount },
        ],
      }
      const [tag, act, value] = table[o.op]
      action = act
      tagged = { tag, value }
      pool = ex.contractId
      disclosed = base.disclosedContracts as DisclosedContract[]
      rest = {
        configCid: a.configCid,
        pauseCid: s.pause.contractId,
        accountCid: a.accountCid,
        prices: a.prices ?? { collateralFeedCids: [], debtFeedCid: null, attestationCids: [] },
        transfer: a.payment ?? a.payout,
      }
    }

    const loop: LoopMessageFields = {
      network: wallet.payload.network,
      operator: d.operator,
      party,
      action,
      debt: debtId,
      nonce: Number(wallet.payload.nonce),
      expiresAt: expiresAt.toISOString(),
    }
    const message = loopMessage(loop)
    const command: Command = {
      ExerciseCommand: {
        templateId: TEMPLATES.pool,
        contractId: pool,
        choice: 'Pool_LoopWalletExecute',
        choiceArgument: {
          custody: cust,
          walletCid: wallet.contractId,
          action: tagged,
          // The text is under the server seal; submit inserts the signature
          signedMessage: message,
          signature: '',
          nonce: wallet.payload.nonce,
          expiresAt: expiresAt.toISOString(),
          ...rest,
        },
      },
    }
    return {
      prepared: { actAs: [cust], commands: [command], disclosedContracts: disclosed },
      loop,
      message,
    }
  }

  /**
   * Submit a signed operation as the custodian. The command and fields come from the server seal
   * (checks the route). The backend itself checks: the nonce equals the wallet's current nonce, the
   * expiry has not passed, the signature is by the LoopWallet.publicKey key, and the key yields the
   * party fingerprint.
   */
  async function submit(
    p: LoopSealedBody,
    signature: string,
  ): Promise<{ updateId: string; match: SignatureMatch }> {
    const cust = need()
    const wallet = await walletOf(p.loop.party)
    if (Number(wallet.payload.nonce) !== p.loop.nonce)
      throw new LoopError(
        409,
        'LOOP_NONCE_MISMATCH',
        'STALE_CONTRACT: the wallet moved on since this operation was prepared, prepare it again',
      )
    if (Date.parse(p.loop.expiresAt) <= now())
      throw new LoopError(422, 'LOOP_SIGNATURE_EXPIRED', 'The signature expired, prepare again')
    const key = parseLoopPublicKey(wallet.payload.publicKey)
    if (!bindsParty(key, p.loop.party))
      throw new LoopSignatureError('the wallet key does not match the party')
    const message = loopMessage(p.loop)
    const match = verifyLoopSignature(key, message, signature)
    if (!match) throw new LoopSignatureError('the signature does not match this Loop account')
    const cmds = p.commands.map((c) => {
      const ex = (c as { ExerciseCommand?: { choiceArgument: Record<string, unknown> } })
        .ExerciseCommand
      if (!ex) return c
      // The seal covers the command, but the text in it and the fields' text must match
      if (ex.choiceArgument.signedMessage !== message)
        throw new LoopSignatureError('the signed text does not match the operation')
      return {
        ExerciseCommand: {
          ...ex,
          choiceArgument: { ...ex.choiceArgument, signedMessage: message, signature },
        },
      }
    }) as Command[]
    const r = await ledger.submit([cust], cmds, p.disclosedContracts as never, [], {
      // Idempotent by party and nonce: the ledger drops a repeat of the same operation as a
      // duplicate
      commandId: `loop-${sha(p.loop.party)}-${p.loop.nonce}`,
    })
    return { updateId: r.updateId, match }
  }

  /**
   * Faucet: the registry offers a transfer to the custodian, the custodian credits it to the
   * party's wallet.
   */
  async function receive(party: string, offerCid: string) {
    const cust = need()
    const wallet = await walletOf(party)
    await ledger.submit(
      [cust],
      [
        {
          ExerciseCommand: {
            templateId: TEMPLATES.loopWallet,
            contractId: wallet.contractId,
            choice: 'LoopWallet_Receive',
            choiceArgument: { instructionCid: offerCid, extraArgs },
          },
        },
      ],
      [],
      [],
      { commandId: `loop-receive-${sha(offerCid)}` },
    )
  }

  return { enabled: !!custody, custody, ensureAccount, prepare, submit, receive }
}

export type Loop = ReturnType<typeof createLoop>

function exercise(p: PreparedCommand) {
  const c = p.commands[0] as { ExerciseCommand?: { contractId: string; choiceArgument: unknown } }
  if (!c?.ExerciseCommand) throw new Error('expected an exercise command')
  return c.ExerciseCommand
}
