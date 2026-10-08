/**
 * Review 03.10, item 25: a council of one BitSafe Decentralized Party. The backend reads its
 * GovernanceRules, the DecMan actions and the confirmations as that party, and lets the rules'
 * members open the council page.
 */
import { describe, expect, it } from 'vitest'
import type { LedgerClient } from '../src/ledger/client.ts'
import { DECMAN } from '../src/ledger/ids.ts'
import { createReader, setMembers } from '../src/protocol/reader.ts'
import { d, p } from './fixtures.ts'

const DP = p('LendingCouncil')
const [M1, M2, M3] = [p('Member1'), p('Member2'), p('Member3')]
const future = new Date(Date.now() + 3_600_000).toISOString()
const past = new Date(Date.now() - 1000).toISOString()
const c = (contractId: string, payload: unknown, interfaceView?: unknown) => ({
  contractId,
  templateId: 'x',
  payload,
  createdEventBlob: 'b',
  synchronizerId: 's',
  interfaceView,
})

function ledgerFor(hosted: boolean) {
  return {
    query: async (party: string, f: { templateId?: string; interfaceId?: string }) => {
      if (!hosted) throw new Error('PERMISSION_DENIED: no readAs right for the party')
      if (party !== DP) return []
      if (f.templateId === DECMAN.rules)
        return [
          c('rules-1', {
            governanceParty: DP,
            members: {
              map: [
                [M1, {}],
                [M2, {}],
                [M3, {}],
              ],
            },
            threshold: '2',
          }),
        ]
      if (f.interfaceId === DECMAN.action)
        return [
          c(
            'act-1',
            {},
            {
              governanceParty: DP,
              proposer: M1,
              actionLabel: 'LendingParams',
              description: 'Lending p1: CBTC borrowCollateralFactor 0.45 -> 0.4',
            },
          ),
        ]
      if (f.templateId === DECMAN.confirmation)
        return [
          c('c1', { confirmer: M1, actionProposalCid: 'act-1', expiresAt: future }),
          c('c1b', { confirmer: M1, actionProposalCid: 'act-1', expiresAt: future }),
          c('c2', { confirmer: M2, actionProposalCid: 'act-1', expiresAt: past }),
        ]
      return []
    },
  } as unknown as LedgerClient
}

describe('DecMan council view', () => {
  it('reads Set members in the JSON API form and as a plain list', () => {
    expect(
      setMembers({
        map: [
          [M1, {}],
          [M2, {}],
        ],
      }),
    ).toEqual([M1, M2])
    expect(setMembers([M1])).toEqual([M1])
    expect(setMembers(null)).toEqual([])
  })

  it('rules, the action with its live confirmations (an expired one and a duplicate do not count)', async () => {
    const v = await createReader(ledgerFor(true), d).decman(DP)
    expect(v).toEqual({
      governanceParty: DP,
      members: [M1, M2, M3],
      threshold: 2,
      actions: [
        {
          contractId: 'act-1',
          label: 'LendingParams',
          description: 'Lending p1: CBTC borrowCollateralFactor 0.45 -> 0.4',
          proposer: M1,
          confirmations: [M1],
        },
      ],
    })
  })

  it('null where this node does not host the party', async () => {
    expect(await createReader(ledgerFor(false), d).decman(DP)).toBeNull()
  })
})
