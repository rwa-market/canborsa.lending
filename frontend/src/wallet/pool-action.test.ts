import { describe, expect, it } from 'vitest'
import { expectedAction } from './pool-action.ts'

describe('pool action expected from the intent (K2)', () => {
  it('takes the amount the user entered, not the one from the server', () => {
    expect(
      expectedAction(
        { kind: 'supply', amount: '100' },
        { kind: 'supply', amount: '100.0', full: false },
      ),
    ).toEqual({ kind: 'supply', amount: '100', full: false })
    expect(() =>
      expectedAction(
        { kind: 'supply', amount: '100' },
        { kind: 'supply', amount: '101', full: false },
      ),
    ).toThrow(/supply amount differs/)
    expect(() =>
      expectedAction(
        { kind: 'supply', amount: '100' },
        { kind: 'supply', amount: '100', full: true },
      ),
    ).toThrow(/supply amount differs/)
  })

  it('withdraw all must carry the full flag', () => {
    const all = { kind: 'withdraw', amount: 'max' } as const
    expect(expectedAction(all, { kind: 'withdraw', amount: '10', full: true })).toEqual({
      kind: 'withdraw',
      amount: '10',
      full: true,
    })
    expect(() => expectedAction(all, { kind: 'withdraw', amount: '10', full: false })).toThrow(
      /whole balance/,
    )
  })

  it('a withdrawal is never a loan and a loan never a withdrawal (risk 7)', () => {
    expect(() =>
      expectedAction({ kind: 'withdraw', amount: '10' }, { kind: 'borrow', amount: '10' }),
    ).toThrow(/not a withdrawal/)
    expect(() =>
      expectedAction(
        { kind: 'borrow', amount: '10' },
        { kind: 'withdraw', amount: '10', full: false },
      ),
    ).toThrow(/loan differs/)
    expect(
      expectedAction({ kind: 'borrow', amount: '10' }, { kind: 'borrow', amount: '10.0' }),
    ).toEqual({ kind: 'borrow', amount: '10' })
  })

  it('repay is a supply; repay all is bounded by the debt and debt + 0.2 %', () => {
    const all = { kind: 'repay', amount: 'max', debt: '1000' } as const
    const repay = (amount: string) => expectedAction(all, { kind: 'supply', amount, full: true })
    expect(repay('1002')).toEqual({ kind: 'supply', amount: '1002', full: true })
    expect(repay('1000')).toEqual({ kind: 'supply', amount: '1000', full: true })
    expect(() => repay('1002.000001')).toThrow(/above your debt/)
    expect(() => repay('999.9999999999')).toThrow(/below your debt/)
    expect(() => expectedAction(all, { kind: 'supply', amount: '1000', full: false })).toThrow(
      /whole debt/,
    )
    expect(
      expectedAction(
        { kind: 'repay', amount: '50' },
        { kind: 'supply', amount: '50', full: false },
      ),
    ).toEqual({ kind: 'supply', amount: '50', full: false })
  })

  it('collateral: market and exact amount, not more than held', () => {
    const intent = {
      kind: 'withdraw-collateral',
      marketId: 'CC',
      amount: '100',
      collateral: '100',
    } as const
    expect(
      expectedAction(intent, { kind: 'withdraw-collateral', marketId: 'CC', amount: '100' }),
    ).toEqual({ kind: 'withdraw-collateral', marketId: 'CC', amount: '100' })
    expect(() =>
      expectedAction(intent, { kind: 'withdraw-collateral', marketId: 'CBTC', amount: '100' }),
    ).toThrow(/another market/)
    expect(() =>
      expectedAction(
        { ...intent, amount: '101' },
        { kind: 'withdraw-collateral', marketId: 'CC', amount: '101' },
      ),
    ).toThrow(/larger than your collateral/)
  })

  it('refuses operations outside the pool', () => {
    expect(() =>
      expectedAction(
        { kind: 'income-withdraw', incomeCid: 'c' },
        { kind: 'supply', amount: '1', full: false },
      ),
    ).toThrow(/not a lending wallet operation/)
  })
})
