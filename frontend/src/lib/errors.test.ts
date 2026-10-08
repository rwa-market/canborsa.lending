import { describe, expect, it } from 'vitest'
import { explainError } from './errors'

describe('known rejections in words', () => {
  it('an expired signature says so, by code and by ledger text (review 08.10, item 8)', () => {
    expect(explainError('The signature expired, prepare again', 'LOOP_SIGNATURE_EXPIRED')).toMatch(
      /expired.*30 minutes/,
    )
    expect(explainError('EVM signature expired')).toMatch(/start the operation again/)
  })
})
