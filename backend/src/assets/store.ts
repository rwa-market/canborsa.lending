/**
 * Real asset state in SQLite (shared database of the blue/green slots). Tables are created
 * only with profile real: the DevNet database does not change.
 *
 * - deposit_seen: incoming instructions the bot has already processed (credited or quarantined);
 * - deposit_quarantine: deposits without a valid memo and others that cannot be accepted blindly;
 * - xreserve_claim: xReserve deposit claim by Ethereum transaction hash. PRIMARY KEY on hash
 *   and UNIQUE on DepositAttestation: retries and double use of an attestation are impossible;
 * - redeem_state: step of a USDCx withdrawal to Ethereum by requestId (burn until Complete/Refund);
 * - custody_cursor: offset of the custodian transaction stream processed by the deposits bot
 *   (one-step CC deposits and withdrawal refunds). Their deposit_seen keys are the depositRef:
 *   "<updateId>:<nodeId>" and "refund:<transferCid>".
 */
import type Database from 'better-sqlite3'

const DDL = `
CREATE TABLE IF NOT EXISTS deposit_seen (
  instruction_cid TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  address TEXT,
  update_id TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deposit_quarantine (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  cause TEXT NOT NULL,
  instrument_admin TEXT,
  instrument_id TEXT,
  amount TEXT,
  sender TEXT,
  reason TEXT,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS deposit_quarantine_status ON deposit_quarantine (status);
CREATE TABLE IF NOT EXISTS xreserve_claim (
  tx_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  amount TEXT,
  attestation_cid TEXT UNIQUE,
  status TEXT NOT NULL,
  update_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS custody_cursor (
  name TEXT PRIMARY KEY,
  ledger_offset INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS redeem_state (
  request_id TEXT PRIMARY KEY,
  request_cid TEXT NOT NULL,
  status TEXT NOT NULL,
  burn_reference TEXT,
  reason TEXT,
  updated_at INTEGER NOT NULL
);
`

export type QuarantineCause =
  | 'no-reason'
  | 'bad-reason'
  | 'unknown-instrument'
  | 'rejected'
  | 'unattributed-holdings'
  | 'minted-not-credited'
  | 'refund-unattributed'
  | 'reclaim-rejected'

export interface QuarantineEntry {
  id: string
  source: 'instruction' | 'preapproval' | 'refund' | 'reclaim' | 'xreserve' | 'reconcile'
  cause: QuarantineCause
  instrument?: { admin: string; id: string }
  amount?: string
  sender?: string
  reason?: string
  detail?: string
}

export type ClaimStatus = 'verifying' | 'minted' | 'credited'
export type RedeemStatus = 'burning' | 'burned' | 'completed' | 'refunded' | 'stuck'

/** A claim in progress longer than this is abandoned (process crashed) and can be taken over. */
export const CLAIM_LOCK_MS = 60_000

export function createRealAssetsStore(sqlite: Database.Database, now: () => number = Date.now) {
  sqlite.exec(DDL)
  const q = {
    seen: sqlite.prepare('SELECT outcome FROM deposit_seen WHERE instruction_cid = ?'),
    markSeen: sqlite.prepare(
      'INSERT OR IGNORE INTO deposit_seen (instruction_cid, outcome, address, update_id, at) VALUES (?, ?, ?, ?, ?)',
    ),
    quarantine: sqlite.prepare(
      `INSERT INTO deposit_quarantine (id, source, cause, instrument_admin, instrument_id, amount, sender, reason, detail, detected_at)
       VALUES (@id, @source, @cause, @admin, @instrumentId, @amount, @sender, @reason, @detail, @at)
       ON CONFLICT(id) DO UPDATE SET cause = excluded.cause, amount = excluded.amount, detail = excluded.detail
       WHERE deposit_quarantine.status = 'open'`,
    ),
    openCount: sqlite.prepare(
      "SELECT cause, COUNT(*) AS n FROM deposit_quarantine WHERE status = 'open' GROUP BY cause",
    ),
    listOpen: sqlite.prepare(
      "SELECT * FROM deposit_quarantine WHERE status = 'open' ORDER BY detected_at",
    ),
    resolve: sqlite.prepare(
      "UPDATE deposit_quarantine SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
    ),
    claim: sqlite.prepare('SELECT * FROM xreserve_claim WHERE tx_hash = ?'),
    claimInsert: sqlite.prepare(
      "INSERT OR IGNORE INTO xreserve_claim (tx_hash, address, status, created_at, updated_at) VALUES (?, ?, 'verifying', ?, ?)",
    ),
    claimTakeover: sqlite.prepare(
      "UPDATE xreserve_claim SET updated_at = ? WHERE tx_hash = ? AND address = ? AND status = 'verifying' AND updated_at < ?",
    ),
    claimAttest: sqlite.prepare(
      'UPDATE xreserve_claim SET attestation_cid = ?, amount = ?, updated_at = ? WHERE tx_hash = ?',
    ),
    claimStatus: sqlite.prepare(
      'UPDATE xreserve_claim SET status = ?, update_id = ?, updated_at = ? WHERE tx_hash = ?',
    ),
    claimDrop: sqlite.prepare(
      "DELETE FROM xreserve_claim WHERE tx_hash = ? AND status = 'verifying'",
    ),
    usedAttestation: sqlite.prepare('SELECT tx_hash FROM xreserve_claim WHERE attestation_cid = ?'),
    cursor: sqlite.prepare('SELECT ledger_offset FROM custody_cursor WHERE name = ?'),
    setCursor: sqlite.prepare(
      'INSERT INTO custody_cursor (name, ledger_offset, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET ledger_offset = excluded.ledger_offset, at = excluded.at',
    ),
    redeem: sqlite.prepare('SELECT * FROM redeem_state WHERE request_id = ?'),
    redeemSet: sqlite.prepare(
      `INSERT INTO redeem_state (request_id, request_cid, status, burn_reference, reason, updated_at)
       VALUES (@requestId, @requestCid, @status, @burnReference, @reason, @at)
       ON CONFLICT(request_id) DO UPDATE SET status = excluded.status,
         burn_reference = COALESCE(excluded.burn_reference, redeem_state.burn_reference),
         reason = COALESCE(excluded.reason, redeem_state.reason), updated_at = excluded.updated_at`,
    ),
  }

  return {
    /** The instruction is already processed: credited or quarantined. */
    seen: (cid: string) => (q.seen.get(cid) as { outcome: string } | undefined)?.outcome ?? null,
    markCredited(cid: string, address: string, updateId: string) {
      q.markSeen.run(cid, 'credited', address, updateId, now())
    },
    /** Custodian transaction stream offset; null if none (the bot starts from the ledger end). */
    cursor: (name: string) =>
      (q.cursor.get(name) as { ledger_offset: number } | undefined)?.ledger_offset ?? null,
    setCursor: (name: string, offset: number) => void q.setCursor.run(name, offset, now()),
    /** To quarantine; repeating the same record does not add rows. */
    quarantine(e: QuarantineEntry) {
      const tx = sqlite.transaction(() => {
        q.quarantine.run({
          id: e.id,
          source: e.source,
          cause: e.cause,
          admin: e.instrument?.admin ?? null,
          instrumentId: e.instrument?.id ?? null,
          amount: e.amount ?? null,
          sender: e.sender ?? null,
          reason: e.reason ?? null,
          detail: e.detail?.slice(0, 500) ?? null,
          at: now(),
        })
        // processed and not retried any more; xReserve claim and reconciliation handle themselves
        if (e.source !== 'xreserve' && e.source !== 'reconcile')
          q.markSeen.run(e.id, 'quarantined', null, null, now())
      })
      tx()
    },
    quarantineOpen: () => q.listOpen.all() as Record<string, unknown>[],
    quarantineCounts: () =>
      Object.fromEntries(
        (q.openCount.all() as { cause: string; n: number }[]).map((r) => [r.cause, r.n]),
      ) as Partial<Record<QuarantineCause, number>>,
    /** Resolve a quarantine record by hand: released (handled outside the bot) or credited. */
    resolveQuarantine: (id: string, status: 'released' | 'credited') =>
      q.resolve.run(status, now(), id).changes === 1,

    /**
     * Take the transaction claim for an address. ok: can be verified; otherwise a rejection code:
     * already credited/minted, taken by another address, or being processed right now.
     */
    beginClaim(txHash: string, address: string): 'ok' | 'ALREADY_CLAIMED' | 'CLAIM_IN_PROGRESS' {
      const t = now()
      if (q.claimInsert.run(txHash, address, t, t).changes === 1) return 'ok'
      const row = q.claim.get(txHash) as { address: string; status: ClaimStatus } | undefined
      if (!row)
        return q.claimInsert.run(txHash, address, t, t).changes === 1 ? 'ok' : 'CLAIM_IN_PROGRESS'
      if (row.status !== 'verifying' || row.address !== address) return 'ALREADY_CLAIMED'
      return q.claimTakeover.run(t, txHash, address, t - CLAIM_LOCK_MS).changes === 1
        ? 'ok'
        : 'CLAIM_IN_PROGRESS'
    },
    /** Verification rejected: release the claim so the real sender can claim their tx. */
    abandonClaim: (txHash: string) => void q.claimDrop.run(txHash),
    claim: (txHash: string) =>
      (q.claim.get(txHash) as
        | {
            tx_hash: string
            address: string
            amount: string | null
            attestation_cid: string | null
            status: ClaimStatus
            update_id: string | null
          }
        | undefined) ?? null,
    /** Pin the attestation to the claim; false means another claim already took it (UNIQUE). */
    attachAttestation(txHash: string, attestationCid: string, amount: string): boolean {
      const other = q.usedAttestation.get(attestationCid) as { tx_hash: string } | undefined
      if (other && other.tx_hash !== txHash) return false
      try {
        q.claimAttest.run(attestationCid, amount, now(), txHash)
        return true
      } catch (err) {
        if (/UNIQUE/i.test(String(err))) return false
        throw err
      }
    },
    usedAttestations: () =>
      new Set(
        (
          sqlite
            .prepare('SELECT attestation_cid FROM xreserve_claim WHERE attestation_cid IS NOT NULL')
            .all() as { attestation_cid: string }[]
        ).map((r) => r.attestation_cid),
      ),
    setClaimStatus: (txHash: string, status: ClaimStatus, updateId: string | null) =>
      void q.claimStatus.run(status, updateId, now(), txHash),

    redeem: (requestId: string) =>
      (q.redeem.get(requestId) as
        { request_id: string; status: RedeemStatus; burn_reference: string | null } | undefined) ??
      null,
    setRedeem(
      requestId: string,
      requestCid: string,
      status: RedeemStatus,
      extra: { burnReference?: string; reason?: string } = {},
    ) {
      q.redeemSet.run({
        requestId,
        requestCid,
        status,
        burnReference: extra.burnReference ?? null,
        reason: extra.reason?.slice(0, 500) ?? null,
        at: now(),
      })
    },
  }
}

export type RealAssetsStore = ReturnType<typeof createRealAssetsStore>
