import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createAuth, DEFAULT_SESSION_TTL_MS, SEAL_TTL_MS, sqliteAuthStore } from '../src/auth.ts'
import { createIndexer, IndexerIdentityError, type Tx } from '../src/bots/indexer.ts'
import { backupDatabase, createDb } from '../src/db/client.ts'
import { accountState, operationHistory } from '../src/db/schema.ts'
import type { Deployment } from '../src/deployment.ts'
import type { LedgerClient } from '../src/ledger/client.ts'
import { createMetrics } from '../src/metrics.ts'

const d = { operator: 'op' } as Deployment
function fakeLedger(state: { end: number; pruned: number; participant: string; txs?: Tx[] }) {
  return {
    ledgerEnd: async () => state.end,
    prunedOffset: async () => state.pruned,
    participantId: async () => state.participant,
    updates: async (_p: string, _t: string[], from: number) => {
      const txs = (state.txs ?? []).filter((t) => t.offset > from)
      return txs.length
        ? {
            transactions: txs,
            lastOffset: Math.max(...txs.map((t) => t.offset)),
            count: txs.length,
          }
        : { transactions: [], lastOffset: null, count: 0 }
    },
  } as unknown as LedgerClient
}
const accountTx = (offset: number, collateral: string): Tx => ({
  updateId: `u${offset}`,
  offset,
  effectiveAt: '2026-10-01T00:00:00Z',
  events: [
    {
      CreatedEvent: {
        templateId: 'pkg:Lending.Account:Account',
        createArgument: {
          owner: 'bob',
          operator: 'op',
          scaledSupply: '0',
          positions: [['CBTC', { collateral, scaledDebt: '0', collateralEnabled: true }]],
        },
      },
    },
  ],
})

describe('B-11, A-19: indexer checkpoint identity', () => {
  it('stores the participant and refuses a database from another participant', async () => {
    const db = createDb(':memory:')
    const state = { end: 5, pruned: 0, participant: 'PAR::a' }
    await createIndexer(fakeLedger(state), d, db).step()
    state.participant = 'PAR::b'
    await expect(createIndexer(fakeLedger(state), d, db).step()).rejects.toBeInstanceOf(
      IndexerIdentityError,
    )
  })

  it('refuses a checkpoint beyond the ledger end (ledger reset), or resets when allowed', async () => {
    const db = createDb(':memory:')
    const state = { end: 5, pruned: 0, participant: 'PAR::a', txs: [accountTx(3, '1')] }
    await createIndexer(fakeLedger(state), d, db).step()
    state.end = 2
    state.txs = []
    await expect(createIndexer(fakeLedger(state), d, db).step()).rejects.toThrow(/ledger was reset/)
    await createIndexer(fakeLedger(state), d, db, 200, { resetOnLedgerChange: true }).step()
    expect(db.select().from(accountState).all()).toHaveLength(0)
  })

  it('records a prune gap past the checkpoint and alerts', async () => {
    const db = createDb(':memory:')
    const state = { end: 10, pruned: 0, participant: 'PAR::a' }
    await createIndexer(fakeLedger(state), d, db).step()
    state.end = 900
    state.pruned = 500
    const metrics = createMetrics()
    const errors: string[] = []
    const log = { error: (_o: unknown, m: string) => errors.push(m) } as never
    const indexer = createIndexer(fakeLedger(state), d, db, 200, { metrics, log })
    await indexer.step()
    expect(indexer.gaps()).toEqual([expect.objectContaining({ fromOffset: 10, toOffset: 500 })])
    expect(metrics.get('indexer_prune_gaps_total')).toBe(1)
    expect(errors[0]).toMatch(/history gap/)
    expect(indexer.lag()).toBe(0)
  })

  it('a fresh database on a pruned node starts at the boundary without a gap', async () => {
    const db = createDb(':memory:')
    const indexer = createIndexer(
      fakeLedger({ end: 900, pruned: 500, participant: 'PAR::a' }),
      d,
      db,
    )
    await indexer.step()
    expect(indexer.gaps()).toEqual([])
  })

  it('an older account state never overwrites a newer one', async () => {
    const db = createDb(':memory:')
    const state = { end: 20, pruned: 0, participant: 'PAR::a', txs: [accountTx(15, '2')] }
    await createIndexer(fakeLedger(state), d, db).step()
    // replay of an old page (e.g. after a manual cursor reset)
    db.update(accountState).set({ offset: 15 }).run()
    const replay = createIndexer(fakeLedger({ ...state, txs: [accountTx(12, '9')] }), d, db)
    db.sqlite.exec('UPDATE ledger_checkpoint SET offset = 0')
    await replay.step()
    const row = db.select().from(accountState).get()!
    expect(row.offset).toBe(15)
    expect(JSON.parse(row.payload).positions[0][1].collateral).toBe('2')
  })

  it('history rows have the shared HistoryEntry shape; unknown ops are dropped', async () => {
    const db = createDb(':memory:')
    const row = {
      updateId: 'u',
      nodeId: 0,
      offset: 1,
      effectiveAt: 'x',
      party: 'bob',
      marketId: null,
      amount: '1',
    }
    db.insert(operationHistory)
      .values({ ...row, op: 'supply', debtPart: '0.5' })
      .run()
    db.insert(operationHistory)
      .values({ ...row, nodeId: 1, op: 'bogus' as never })
      .run()
    const h = createIndexer(fakeLedger({ end: 0, pruned: 0, participant: 'p' }), d, db).history(
      'bob',
    )
    expect(h).toEqual([
      {
        ...row,
        op: 'supply',
        credited: null,
        collateralTaken: null,
        debtPart: '0.5',
        balanceAfter: null,
        writtenOff: null,
      },
    ])
  })

  it('absorb rows: the rest stays as a deposit; a shortfall is written off, the balance is 0', () => {
    const db = createDb(':memory:')
    const base = { nodeId: 0, effectiveAt: 'x', party: 'carol', marketId: null, op: 'absorb' }
    // example 4: debt 3 000, credited 6 045 → 3 045 stays
    db.insert(operationHistory)
      .values({ ...base, updateId: 'a', offset: 1, amount: '3000', credited: '6045' } as never)
      .run()
    // example 6: debt 3 000, credited 2 325 → 675 written off by the protocol, balance 0
    db.insert(operationHistory)
      .values({ ...base, updateId: 'b', offset: 2, amount: '3000', credited: '2325' } as never)
      .run()
    const h = createIndexer(fakeLedger({ end: 0, pruned: 0, participant: 'p' }), d, db).history(
      'carol',
    )
    expect(h.find((e) => e.updateId === 'a')).toMatchObject({
      balanceAfter: '3045.0000000000',
      writtenOff: null,
    })
    expect(h.find((e) => e.updateId === 'b')).toMatchObject({
      balanceAfter: '0.0000000000',
      writtenOff: '675.0000000000',
    })
  })
})

describe('B-11: SQLite online backup', () => {
  it('copies a live database into a consistent file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-'))
    const src = join(dir, 'lending.db')
    const db = createDb(src)
    db.insert(operationHistory)
      .values({
        updateId: 'u',
        nodeId: 0,
        offset: 1,
        effectiveAt: 'x',
        party: 'bob',
        op: 'supply',
        marketId: null,
        amount: '5',
        seized: null,
      })
      .run()
    const dest = join(dir, 'backup', 'copy.db')
    await backupDatabase(src, dest)
    const copy = new Database(dest, { readonly: true })
    expect(copy.prepare('SELECT amount FROM operation_history').get()).toEqual({ amount: '5' })
    copy.close()
    db.sqlite.close()
  })
})

describe('B-18: sessions and seals', () => {
  const secret = 'x'.repeat(40)
  it('sessions last 2 hours by default and are configurable', () => {
    let t = 1_000_000
    const auth = createAuth(secret, () => t)
    const token = auth.issue('alice::1')
    t += DEFAULT_SESSION_TTL_MS - 1
    expect(auth.verify(token)).toBe('alice::1')
    t += 1
    expect(auth.verify(token)).toBeNull()
    const short = createAuth(secret, () => t, { sessionTtlMs: 60_000 })
    const s = short.issue('alice::1')
    t += 60_000
    expect(short.verify(s)).toBeNull()
  })

  it('logout revokes the token for every slot sharing the database', () => {
    const db = createDb(':memory:')
    const slotA = createAuth(secret, Date.now, { store: sqliteAuthStore(db) })
    const slotB = createAuth(secret, Date.now, { store: sqliteAuthStore(db) })
    const token = slotA.issue('alice::1')
    expect(slotB.verify(token)).toBe('alice::1')
    expect(slotA.revoke(token)).toBe(true)
    expect(slotB.verify(token)).toBeNull()
    expect(slotA.revoke('garbage')).toBe(false)
  })

  it('a seal used in slot A is rejected in slot B', () => {
    const db = createDb(':memory:')
    const slotA = createAuth(secret, Date.now, { store: sqliteAuthStore(db) })
    const slotB = createAuth(secret, Date.now, { store: sqliteAuthStore(db) })
    const body = { actAs: ['alice::1'], commands: [], disclosedContracts: [] }
    const seal = slotA.sealCommand(body)
    expect(slotA.checkSeal(body, seal)).toBe('ok')
    expect(slotB.checkSeal(body, seal)).toBe('reused')
    expect(SEAL_TTL_MS).toBe(120_000)
  })
})
