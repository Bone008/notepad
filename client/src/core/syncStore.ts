import { createStore, get, set, type UseStore } from 'idb-keyval';

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

/** Small per-vault key/value store next to the y-indexeddb document database. */
export class SyncStore {
  private store: UseStore;

  constructor(readonly dbName: string) {
    this.store = createStore(dbName, 'kv');
  }

  async load(): Promise<SyncState> {
    const [lastSeq, syncedSV, outbox] = await Promise.all([
      get<number>('lastSeq', this.store),
      get<Uint8Array>('syncedSV', this.store),
      get<Uint8Array[]>('outbox', this.store),
    ]);
    return { lastSeq: lastSeq ?? 0, syncedSV: syncedSV ?? null, outbox: outbox ?? [] };
  }

  setLastSeq(n: number): Promise<void> {
    return set('lastSeq', n, this.store);
  }

  setSyncedSV(sv: Uint8Array | null): Promise<void> {
    return set('syncedSV', sv, this.store);
  }

  setOutbox(outbox: Uint8Array[]): Promise<void> {
    return set('outbox', outbox, this.store);
  }
}

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
