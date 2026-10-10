import { createStore, get, set, type UseStore } from 'idb-keyval';
import { utf8Decode, utf8Encode } from '@notepad/shared';
import { openBytes, sealBytes } from './localLock.js';

export interface SyncState {
  /** Highest server seq applied to the local doc. */
  lastSeq: number;
  /** Yjs state vector at the last moment the doc was known to be fully on the server. */
  syncedSV: Uint8Array | null;
  /** Local Yjs updates not yet acknowledged by the server. */
  outbox: Uint8Array[];
}

export function syncDbName(namespace: string, vaultId: string): string {
  return `notepad-${namespace}sync-${vaultId}`;
}

export function docDbName(namespace: string, vaultId: string): string {
  return `notepad-${namespace}doc-${vaultId}`;
}

/**
 * Small per-vault key/value store next to the document database. Values pass through the local
 * access control codec; legacy plaintext values are still read.
 */
export class SyncStore {
  private store: UseStore;
  /** Sealing is async: serialize writes so a stale value can never land after a newer one. */
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly dbName: string) {
    this.store = createStore(dbName, 'kv');
  }

  private ctx(key: string): string {
    return `sync|${this.dbName}|${key}`;
  }

  private write(key: string, encode: () => Promise<unknown>): Promise<void> {
    const next = this.writes.then(async () => set(key, await encode(), this.store));
    this.writes = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<SyncState> {
    const [lastSeq, syncedSV, outbox] = await Promise.all([
      get<unknown>('lastSeq', this.store),
      get<unknown>('syncedSV', this.store),
      get<unknown[]>('outbox', this.store),
    ]);
    return {
      lastSeq: typeof lastSeq === 'number' ? lastSeq : lastSeq == null ? 0 : Number(utf8Decode(await openBytes(this.ctx('lastSeq'), lastSeq))),
      syncedSV: syncedSV == null ? null : await openBytes(this.ctx('syncedSV'), syncedSV),
      outbox: outbox ? await Promise.all(outbox.map((u) => openBytes(this.ctx('outbox'), u))) : [],
    };
  }

  setLastSeq(n: number): Promise<void> {
    return this.write('lastSeq', () => sealBytes(this.ctx('lastSeq'), utf8Encode(String(n))));
  }

  setSyncedSV(sv: Uint8Array | null): Promise<void> {
    return this.write('syncedSV', async () => (sv ? sealBytes(this.ctx('syncedSV'), sv) : null));
  }

  setOutbox(outbox: Uint8Array[]): Promise<void> {
    const snapshot = outbox.slice();
    return this.write('outbox', () => Promise.all(snapshot.map((u) => sealBytes(this.ctx('outbox'), u))));
  }

  /** Rewrites every value with the current codec settings (used when toggling local access control). */
  async reseal(): Promise<void> {
    const st = await this.load();
    await Promise.all([this.setLastSeq(st.lastSeq), this.setSyncedSV(st.syncedSV), this.setOutbox(st.outbox)]);
  }
}

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
