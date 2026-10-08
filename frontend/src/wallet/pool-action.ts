/**
 * The custodial account pool action (Loop, lending-core-v2) expected from the user's intent. The
 * action type is EvmAction from Lending.Evm: Pool_LoopWalletExecute takes the same variant, hence the
 * name left over from the EVM account.
 *
 * Compound V3 operations (K2): supply (with full: repay the whole debt), withdraw (never borrows),
 * borrow (a withdrawal that may go below zero), deposit and withdraw collateral. Withdraw and Borrow
 * are different texts (risk 7): a withdrawal never turns into a loan unsigned.
 * Module without React and alias imports: vitest runs it.
 */
import type { EvmAction } from '@lending/shared'
import { cmp, isDecimal, mulRatio } from '../lib/decimal.ts'
import { CommandRejected, type Intent } from './verify.ts'

/** "Repay all": cap at most the snapshot debt plus a 0.2 % buffer (as for Canton parties). */
const REPAY_ALL_MARGIN = { num: 1002n, den: 1000n }

const need = (ok: unknown, why: string): void => {
  if (!ok) throw new CommandRejected(why)
}

/**
 * The action expected from the intent; amount from the server action is used only for "all".
 */
export function expectedAction(intent: Intent, got: EvmAction): EvmAction {
  const same = (a: string, b: string) => isDecimal(a) && isDecimal(b) && cmp(a, b) === 0
  switch (intent.kind) {
    case 'supply':
      need(
        got.kind === 'supply' && !got.full && same(got.amount, intent.amount),
        'the supply amount differs',
      )
      return { kind: 'supply', amount: intent.amount, full: false }
    case 'repay': {
      // Repay is a supply that pays the debt first (K2)
      need(got.kind === 'supply', 'the operation is not a repayment')
      const g = got as Extract<EvmAction, { kind: 'supply' }>
      if (intent.amount === 'max') {
        need(g.full, 'repay all must repay the whole debt')
        need(isDecimal(g.amount), 'the repay bound is not a decimal')
        need(!!intent.debt, 'repay all needs your current debt to bound the payment')
        if (intent.debt) {
          need(cmp(g.amount, intent.debt) >= 0, 'the repay bound is below your debt')
          need(
            cmp(g.amount, mulRatio(intent.debt, REPAY_ALL_MARGIN.num, REPAY_ALL_MARGIN.den)) <= 0,
            'the repay bound is above your debt',
          )
        }
        return { kind: 'supply', amount: g.amount, full: true }
      }
      need(!g.full && same(g.amount, intent.amount), 'the repayment amount differs')
      return { kind: 'supply', amount: intent.amount, full: false }
    }
    case 'withdraw': {
      need(got.kind === 'withdraw', 'the operation is not a withdrawal')
      const g = got as Extract<EvmAction, { kind: 'withdraw' }>
      if (intent.amount === 'max') {
        need(g.full, 'withdraw all must withdraw the whole balance')
        need(isDecimal(g.amount), 'the withdrawal amount is not a decimal')
        return { kind: 'withdraw', amount: g.amount, full: true }
      }
      need(!g.full && same(g.amount, intent.amount), 'the withdrawal amount differs')
      return { kind: 'withdraw', amount: intent.amount, full: false }
    }
    case 'borrow':
      need(
        got.kind === 'borrow' && same(got.amount, intent.amount),
        'the loan differs from what you entered',
      )
      return { kind: 'borrow', amount: intent.amount }
    case 'deposit-collateral':
      need(
        got.kind === 'deposit-collateral' &&
          got.marketId === intent.marketId &&
          same(got.amount, intent.amount),
        'the deposit differs from what you entered',
      )
      return { kind: 'deposit-collateral', marketId: intent.marketId, amount: intent.amount }
    case 'withdraw-collateral':
      need(
        got.kind === 'withdraw-collateral' && got.marketId === intent.marketId,
        'the collateral withdrawal is for another market',
      )
      need(
        same((got as Extract<EvmAction, { kind: 'withdraw-collateral' }>).amount, intent.amount),
        'the collateral amount differs',
      )
      need(
        intent.collateral === undefined || cmp(intent.amount, intent.collateral) <= 0,
        'the withdrawal is larger than your collateral',
      )
      return { kind: 'withdraw-collateral', marketId: intent.marketId, amount: intent.amount }
    default:
      throw new CommandRejected(`${intent.kind} is not a lending wallet operation`)
  }
}
