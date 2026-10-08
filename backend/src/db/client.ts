import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.ts'

/**
 * The schema is small and only grows: tables are created at startup, no separate migration step.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS ledger_checkpoint (
  stream TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_history (
  update_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  effective_at TEXT NOT NULL,
  party TEXT NOT NULL,
  op TEXT NOT NULL,
  market_id TEXT,
  amount TEXT,
  seized TEXT,
  credited TEXT,
  collateral_taken TEXT,
  debt_part TEXT,
  PRIMARY KEY (update_id, node_id)
);
CREATE INDEX IF NOT EXISTS operation_history_party ON operation_history (party, offset);
CREATE TABLE IF NOT EXISTS account_state (
  owner TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS indexer_gap (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL,
  from_offset INTEGER NOT NULL,
  to_offset INTEGER NOT NULL,
  detected_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revoked_session (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS used_seal (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`

/** Columns added after the first version: a database from a previous run gets them here. */
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ['operation_history', 'seized', 'TEXT'],
  // B-11, A-19: which participant the stream was read from; a different participant on an old
  // database is rejected
  ['ledger_checkpoint', 'participant_id', 'TEXT'],
  // Compound V3 model: absorb records and the debt part of supply and withdraw
  ['operation_history', 'credited', 'TEXT'],
  ['operation_history', 'collateral_taken', 'TEXT'],
  ['operation_history', 'debt_part', 'TEXT'],
]

export function createDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite: Database.Database = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.exec(DDL)
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column))
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
  const db = drizzle(sqlite, { schema })
  return Object.assign(db, { sqlite }) as typeof db & { sqlite: Database.Database }
}

/**
 * Online SQLite backup (B-11): the better-sqlite3 backup API copies the database page by page while
 * the process writes to it (WAL). The result is a consistent file that can be opened as a database.
 */
export async function backupDatabase(source: string, destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true })
  const db = new Database(source, { readonly: true, fileMustExist: true })
  try {
    await db.backup(destination)
  } finally {
    db.close()
  }
}

export type Db = ReturnType<typeof createDb>
