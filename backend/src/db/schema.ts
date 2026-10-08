import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Last processed ledger offset per stream (the indexer).
 * Needed for idempotency after a restart (rule 9 in CLAUDE.md).
 */
export const ledgerCheckpoint = sqliteTable('ledger_checkpoint', {
  stream: text('stream').primaryKey(),
  offset: integer('offset').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  /** Participant the stream was read from (B-11, A-19); null: database predates this column. */
  participantId: text('participant_id'),
})

/** History gaps: the node pruned events beyond the checkpoint (B-11). */
export const indexerGap = sqliteTable('indexer_gap', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  stream: text('stream').notNull(),
  fromOffset: integer('from_offset').notNull(),
  toOffset: integer('to_offset').notNull(),
  detectedAt: integer('detected_at', { mode: 'timestamp' }).notNull(),
})

/** Revoked sessions (logout, B-18): until their expiry. */
export const revokedSession = sqliteTable('revoked_session', {
  jti: text('jti').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
})

/** Used /dev/submit seals: shared by the two blue/green slots (B-18). */
export const usedSeal = sqliteTable('used_seal', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
})

/** Completed user operations (T3.1.7). Key is the ledger event: a replay does not duplicate. */
export const operationHistory = sqliteTable(
  'operation_history',
  {
    updateId: text('update_id').notNull(),
    nodeId: integer('node_id').notNull(),
    offset: integer('offset').notNull(),
    effectiveAt: text('effective_at').notNull(),
    party: text('party').notNull(),
    op: text('op').notNull(),
    marketId: text('market_id'),
    /** Executed amount (re-audit L4); for an absorb, the debt written off in USDCx. */
    amount: text('amount'),
    /** Before the Compound V3 model: collateral seized by a liquidation. Unused now. */
    seized: text('seized'),
    /** Absorb: USDCx credited for the collateral. */
    credited: text('credited'),
    /** Absorb: collateral taken, JSON [{marketId, amount}]. */
    collateralTaken: text('collateral_taken'),
    /** Supply that repaid debt / withdraw that borrowed: the debt part of the amount. */
    debtPart: text('debt_part'),
  },
  (t) => [primaryKey({ columns: [t.updateId, t.nodeId] })],
)

/**
 * Latest account state per owner, and the pool under `POOL_STATE_KEY`: the indexer uses them to
 * compute collateral taken, the debt part and the USDCx credited on absorb.
 */
export const accountState = sqliteTable('account_state', {
  owner: text('owner').primaryKey(),
  offset: integer('offset').notNull(),
  payload: text('payload').notNull(),
})
