/**
 * Loop wallet operation check before signing (lending-core-v2, custodial account
 * LoopWallet, like EVM in ADR-004).
 *
 * Loop does not run our DARs, so the user signs the operation text with Ed25519
 * (`provider.signMessage`), and the custodian executes it (`Pool_LoopWalletExecute`). The backend
 * verifies the signature, the contract stores the signed text in the event. So all that protects
 * the user is the text. The frontend:
 * - builds the text itself from what the user entered: action, amount, market, own party,
 *   network from /config.loop and operator from the build, expiry at most 30 min ahead; requires
 *   an exact character-for-character match with the backend text;
 * - requires the custodian command to carry exactly this text (signedMessage), the same nonce,
 *   expiry and action, and to be submitted by the custodian from /config.loop.
 * Module without React and alias imports: vitest runs it.
 */
import {
  type EvmAction,
  loopMessage as sharedLoopMessage,
  type LoopMessageFields,
} from '@lending/shared'
import { cmp, isDecimal } from '../lib/decimal.ts'
import { expectedAction } from './pool-action.ts'
import { canonicalLoopKey } from './loop-signature.ts'
import { CommandRejected, type Intent, type SignSummary } from './verify.ts'

export type { LoopMessageFields }

/** POST /loop/prepare response: the sealed custodian command, fields and text to sign. */
export interface LoopPreparedResponse {
  actAs: string[]
  commands: unknown[]
  disclosedContracts: unknown[]
  loop: LoopMessageFields
  seal: string
  message: string
}

export interface LoopVerifyContext {
  /** Session party */
  party: string
  /** Protocol operator: pinned in the build or from /config */
  operator: string
  /** Loop account network from /config.loop.network */
  network: string
  /** Custodian from /config.loop.custody */
  custody: string
  now: Date
}

export const LOOP_CHOICE = 'Pool_LoopWalletExecute'
/** The contract accepts a signature at most 30 minutes ahead; one minute is for clock skew. */
const MAX_TTL_MS = 30 * 60_000
const SKEW_MS = 60_000

const need = (ok: unknown, why: string): void => {
  if (!ok) throw new CommandRejected(why)
}

/**
 * Operation text for signMessage (shared with the backend, @lending/shared). The contract builds
 * the same text (Lending.Loop.loopMessage) and checks it against signedMessage.
 */
export const loopMessage = sharedLoopMessage

/** Variant tag in the command: Pool_LoopWalletExecute takes the same EvmAction (Lending.Evm). */
const TAG: Record<EvmAction['kind'], string> = {
  supply: 'EvmSupply',
  withdraw: 'EvmWithdraw',
  borrow: 'EvmBorrow',
  'deposit-collateral': 'EvmDepositCollateral',
  'withdraw-collateral': 'EvmWithdrawCollateral',
}

/** Variant fields: everything except kind. */
const actionValue = (a: EvmAction): Record<string, unknown> =>
  Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'kind'))

const sameValue = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && isDecimal(a) && isDecimal(b)
    ? cmp(a, b) === 0
    : a === b

/** Check the prepared operation; return what the user will see, together with the text. */
export function verifyLoopPrepared(
  p: LoopPreparedResponse,
  intent: Intent,
  ctx: LoopVerifyContext,
): SignSummary {
  const f = p.loop
  need(f && typeof f === 'object', 'the operation has no signing fields')
  need(f.party === ctx.party, 'the operation is for another account')
  need(f.operator === ctx.operator, 'the operation is for another protocol operator')
  need(f.network === ctx.network, `the operation is for ${f.network}, not ${ctx.network}`)
  // the debt token named in the signed text is fixed: a server cannot rename what the user signs for
  need(f.debt === 'USDCx', 'the operation names another debt token')
  need(Number.isInteger(f.nonce) && f.nonce >= 0, 'bad signature nonce')
  const exp = Date.parse(f.expiresAt)
  need(
    Number.isFinite(exp) &&
      exp > ctx.now.getTime() &&
      exp <= ctx.now.getTime() + MAX_TTL_MS + SKEW_MS,
    'the signature expiry is not within 30 minutes',
  )
  const action = expectedAction(intent, f.action as EvmAction)
  let text: string
  try {
    text = loopMessage({ ...f, action })
  } catch (e) {
    throw new CommandRejected(e instanceof Error ? e.message : String(e))
  }
  need(text === p.message, 'the text to sign differs from your operation')

  need(p.actAs.length === 1 && p.actAs[0] === ctx.custody, 'the operation is sent by another party')
  need(p.commands.length === 1, 'expected exactly one command')
  const ex = (
    p.commands[0] as {
      ExerciseCommand?: { choice?: string; choiceArgument?: Record<string, unknown> }
    }
  ).ExerciseCommand
  need(ex?.choiceArgument, 'expected an exercise command')
  need(ex!.choice === LOOP_CHOICE, 'unexpected choice for a Loop wallet operation')
  const arg = ex!.choiceArgument!
  // The contract checks signedMessage against the operation text and stores it: what we sign
  need(arg.signedMessage === p.message, 'the command records another text than you sign')
  need(String(arg.nonce) === String(f.nonce), 'the command nonce differs from the text')
  need(
    Date.parse(String(arg.expiresAt)) === Date.parse(f.expiresAt),
    'the command expiry differs from the text',
  )
  if (arg.custody !== undefined)
    need(arg.custody === ctx.custody, 'the command names another custody party')
  const got = arg.action as { tag?: unknown; value?: Record<string, unknown> } | undefined
  need(got?.tag === TAG[action.kind], 'the command action differs from the text')
  for (const [k, v] of Object.entries(actionValue(action)))
    need(sameValue(got?.value?.[k], v), `the command ${k} differs from the text`)

  // Review 08.10, item 6: a repayment is a supply on the ledger, so the signed text says "Supply";
  // the title keeps the user's action and the line below says why the wallet shows another word
  const line = p.message.split('\n')[1] ?? ''
  const repay = intent.kind === 'repay' && action.kind === 'supply' && !action.full
  return {
    title: repay ? `Repay ${action.amount} ${f.debt}` : line,
    lines: [
      ...(repay
        ? [
            `Loop shows "${line}": a repayment is a supply that pays your debt first, anything above it earns interest.`,
          ]
        : []),
      'Loop signs this text, not a transaction: no network fee.',
      `The protocol custody checks this signature before it moves your ${f.debt} or collateral.`,
    ],
    message: p.message,
  }
}

/**
 * Sign-in text (POST /auth/loop/challenge, off-ledger; loopLoginMessage in @lending/shared): for
 * this site, party, key and network, with the response nonce. Expiry is in the future.
 */
export function verifyLoopLogin(
  message: string,
  want: {
    host: string
    party: string
    publicKey: string
    network: string
    nonce: string
    now: Date
  },
): void {
  need(typeof message === 'string' && message.length < 4096, 'the sign-in text is malformed')
  const lines = message.split('\n')
  need(lines[0]?.includes(want.host), 'the sign-in text names another site')
  need(/Canton Lending/.test(lines[0] ?? ''), 'the sign-in text names another app')
  need(
    lines.some((l) => l === want.party || l === `Party: ${want.party}`),
    'the sign-in text names another account',
  )
  // The key in the text is the backend's canonical hex; the backend checks non-Ed25519 (EC passkey)
  const key = canonicalLoopKey(want.publicKey)
  need(
    key ? lines.includes(`Public Key: ${key}`) : lines.some((l) => l.startsWith('Public Key: ')),
    'the sign-in text names another key',
  )
  need(lines.includes(`Network: ${want.network}`), 'the sign-in text names another network')
  need(want.nonce && lines.includes(`Nonce: ${want.nonce}`), 'the sign-in text is malformed')
  const exp = lines.find((l) => l.startsWith('Expiration Time: '))
  if (exp) {
    const t = Date.parse(exp.slice('Expiration Time: '.length))
    need(Number.isFinite(t) && t > want.now.getTime(), 'the sign-in text has expired')
  }
}
