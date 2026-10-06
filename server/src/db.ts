import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface VaultRow {
  id: string;
  token_hash: Uint8Array;
  head_seq: number;
  bytes_used: number;
}

export interface BlobRow {
  seq: number;
  blob: Uint8Array;
}

export interface VaultState {
  head: number;
  snapshotSeq: number;
  /** Smallest seq still present in the update log, or head+1 if the log is empty. */
  oldestSeq: number;
  updatesSinceSnapshot: number;
}

export type ClaimResult = 'unknown' | 'pending' | 'claimed';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0,
  bytes_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS updates (
  vault_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  blob BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshots (
  vault_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  blob BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pairings (
  lookup_id TEXT PRIMARY KEY,
  blob BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS pairings_expires ON pairings(expires_at);
`;

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

/** All persistence for vaults, encrypted logs, snapshots and pairing records. Server never decrypts anything. */
export class Repo {
  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    this.db.close();
  }

  // ---- vaults -------------------------------------------------------------

  createVault(id: string, tokenHash: Uint8Array, now = Date.now()): boolean {
    try {
      this.db
        .prepare('INSERT INTO vaults (id, token_hash, created_at) VALUES (?, ?, ?)')
        .run(id, tokenHash, now);
      return true;
    } catch (e) {
      if (e instanceof Error && /UNIQUE/.test(e.message)) return false;
      throw e;
    }
  }

  getVault(id: string): VaultRow | null {
    const row = this.db
      .prepare('SELECT id, token_hash, head_seq, bytes_used FROM vaults WHERE id = ?')
      .get(id) as VaultRow | undefined;
    return row ?? null;
  }

  getState(vaultId: string): VaultState {
    const v = this.db.prepare('SELECT head_seq FROM vaults WHERE id = ?').get(vaultId) as { head_seq: number } | undefined;
    const head = v?.head_seq ?? 0;
    const snap = this.db.prepare('SELECT MAX(seq) AS seq FROM snapshots WHERE vault_id = ?').get(vaultId) as {
      seq: number | null;
    };
    const oldest = this.db.prepare('SELECT MIN(seq) AS seq FROM updates WHERE vault_id = ?').get(vaultId) as {
      seq: number | null;
    };
    const snapshotSeq = snap.seq ?? 0;
    return {
      head,
      snapshotSeq,
      oldestSeq: oldest.seq ?? head + 1,
      updatesSinceSnapshot: head - snapshotSeq,
    };
  }

  /** Append one encrypted update; returns its seq. Throws QuotaError if the vault is full. */
  appendUpdate(vaultId: string, blob: Uint8Array, quotaBytes: number, now = Date.now()): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const v = this.db.prepare('SELECT head_seq, bytes_used FROM vaults WHERE id = ?').get(vaultId) as
        | { head_seq: number; bytes_used: number }
        | undefined;
      if (!v) throw new Error('vault not found');
      if (v.bytes_used + blob.byteLength > quotaBytes) throw new QuotaError();
      const seq = v.head_seq + 1;
      this.db.prepare('INSERT INTO updates (vault_id, seq, blob, created_at) VALUES (?, ?, ?, ?)').run(vaultId, seq, blob, now);
      this.db
        .prepare('UPDATE vaults SET head_seq = ?, bytes_used = bytes_used + ? WHERE id = ?')
        .run(seq, blob.byteLength, vaultId);
      this.db.exec('COMMIT');
      return seq;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getUpdatesSince(vaultId: string, since: number): BlobRow[] {
    return this.db
      .prepare('SELECT seq, blob FROM updates WHERE vault_id = ? AND seq > ? ORDER BY seq')
      .all(vaultId, since) as unknown as BlobRow[];
  }

  getLatestSnapshot(vaultId: string): BlobRow | null {
    const row = this.db
      .prepare('SELECT seq, blob FROM snapshots WHERE vault_id = ? ORDER BY seq DESC LIMIT 1')
      .get(vaultId) as BlobRow | undefined;
    return row ?? null;
  }

  /**
   * Store a full-state snapshot covering every update with seq <= baseSeq, then drop those updates.
   * Keeps the two newest snapshots. Returns false if baseSeq is not newer than the current snapshot
   * or is ahead of the log head.
   */
  storeSnapshot(vaultId: string, blob: Uint8Array, baseSeq: number, now = Date.now()): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const st = this.getState(vaultId);
      if (baseSeq > st.head || baseSeq <= st.snapshotSeq) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare('INSERT INTO snapshots (vault_id, seq, blob, created_at) VALUES (?, ?, ?, ?)').run(vaultId, baseSeq, blob, now);
      this.db
        .prepare(
          'DELETE FROM snapshots WHERE vault_id = ? AND seq NOT IN (SELECT seq FROM snapshots WHERE vault_id = ? ORDER BY seq DESC LIMIT 2)',
        )
        .run(vaultId, vaultId);
      this.db.prepare('DELETE FROM updates WHERE vault_id = ? AND seq <= ?').run(vaultId, baseSeq);
      const used = this.db
        .prepare(
          `SELECT (SELECT COALESCE(SUM(length(blob)),0) FROM updates WHERE vault_id = ?1)
                + (SELECT COALESCE(SUM(length(blob)),0) FROM snapshots WHERE vault_id = ?1) AS used`,
        )
        .get(vaultId) as { used: number };
      this.db.prepare('UPDATE vaults SET bytes_used = ? WHERE id = ?').run(used.used, vaultId);
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- pairings -----------------------------------------------------------

  putPairing(lookupId: string, blob: Uint8Array, expiresAt: number): boolean {
    try {
      this.db.prepare('INSERT INTO pairings (lookup_id, blob, expires_at) VALUES (?, ?, ?)').run(lookupId, blob, expiresAt);
      return true;
    } catch (e) {
      if (e instanceof Error && /UNIQUE/.test(e.message)) return false;
      throw e;
    }
  }

  /** One-shot: returns the blob the first time, then blanks it. */
  claimPairing(lookupId: string, now = Date.now()): Uint8Array | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT blob FROM pairings WHERE lookup_id = ? AND claimed_at IS NULL AND expires_at > ?')
        .get(lookupId, now) as { blob: Uint8Array } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare("UPDATE pairings SET blob = X'', claimed_at = ? WHERE lookup_id = ?").run(now, lookupId);
      this.db.exec('COMMIT');
      return row.blob;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  pairingStatus(lookupId: string, now = Date.now()): ClaimResult {
    const row = this.db
      .prepare('SELECT claimed_at FROM pairings WHERE lookup_id = ? AND expires_at > ?')
      .get(lookupId, now) as { claimed_at: number | null } | undefined;
    if (!row) return 'unknown';
    return row.claimed_at === null ? 'pending' : 'claimed';
  }

  sweepPairings(now = Date.now()): number {
    const r = this.db.prepare('DELETE FROM pairings WHERE expires_at <= ?').run(now);
    return Number(r.changes);
  }
}

export class QuotaError extends Error {
  constructor() {
    super('vault quota exceeded');
  }
}
