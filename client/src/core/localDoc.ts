import * as Y from 'yjs';
import { openBytes, sealBytes } from './localLock.js';

/*
 * Local persistence of a Y.Doc in IndexedDB, with every stored update passed through the local
 * access control codec. The database layout matches y-indexeddb (an auto-increment "updates"
 * store of Yjs updates), so documents written by y-indexeddb load unchanged.
 */

const UPDATES = 'updates';
/** Merge the stored updates into one once this many have piled up (same threshold as y-indexeddb). */
const TRIM_SIZE = 500;
const COMPACT_DELAY_MS = 1000;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function openDocDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(UPDATES)) db.createObjectStore(UPDATES, { autoIncrement: true });
      if (!db.objectStoreNames.contains('custom')) db.createObjectStore('custom');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function contextOf(dbName: string): string {
  return `doc|${dbName}`;
}

async function readUpdates(db: IDBDatabase, context: string): Promise<{ updates: Uint8Array[]; lastKey: IDBValidKey | null }> {
  const store = db.transaction(UPDATES, 'readonly').objectStore(UPDATES);
  const [values, keys] = await Promise.all([request(store.getAll()), request(store.getAllKeys())]);
  const updates = await Promise.all(values.map((v) => openBytes(context, v)));
  return { updates, lastKey: keys.length > 0 ? keys[keys.length - 1]! : null };
}

/**
 * Replaces all stored updates with one (re-sealed) update holding the merged state. Rows are
 * applied to `doc` first, so updates written by another tab in the meantime are never dropped.
 */
async function compact(db: IDBDatabase, context: string, doc: Y.Doc, origin: unknown): Promise<void> {
  const { updates, lastKey } = await readUpdates(db, context);
  if (lastKey === null) return;
  Y.transact(doc, () => updates.forEach((u) => Y.applyUpdate(doc, u)), origin, false);
  const value = await sealBytes(context, Y.encodeStateAsUpdate(doc));
  const tx = db.transaction(UPDATES, 'readwrite');
  const store = tx.objectStore(UPDATES);
  store.add(value);
  store.delete(IDBKeyRange.upperBound(lastKey));
  await done(tx);
}

/** Rewrites a document database with the current codec settings (used when toggling local access control). */
export async function resealDocDb(name: string): Promise<void> {
  const db = await openDocDb(name);
  const doc = new Y.Doc();
  try {
    await compact(db, contextOf(name), doc, null);
  } finally {
    doc.destroy();
    db.close();
  }
}

export class LocalDocPersistence {
  readonly whenSynced: Promise<void>;
  private db: IDBDatabase | null = null;
  private readonly context: string;
  private size = 0;
  /** Writes are serialized; sealing is async and a compaction must not interleave with appends. */
  private writes: Promise<void> = Promise.resolve();
  private compactTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private closed: Promise<void> | null = null;

  constructor(
    readonly name: string,
    readonly doc: Y.Doc,
  ) {
    this.context = contextOf(name);
    this.whenSynced = this.load();
    doc.on('update', this.onUpdate);
    doc.on('destroy', this.destroy);
  }

  private async load(): Promise<void> {
    this.db = await openDocDb(this.name);
    const { updates } = await readUpdates(this.db, this.context);
    if (this.destroyed) return;
    Y.transact(this.doc, () => updates.forEach((u) => Y.applyUpdate(this.doc, u)), this, false);
    this.size = updates.length;
    if (this.size >= TRIM_SIZE) this.scheduleCompact();
  }

  private enqueue(write: (db: IDBDatabase) => Promise<void>): void {
    this.writes = this.writes
      .then(async () => {
        await this.whenSynced;
        if (this.db) await write(this.db);
      })
      .catch((e) => console.error('[notepad] local save failed', e));
  }

  private onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    this.enqueue(async (db) => {
      const value = await sealBytes(this.context, update);
      const tx = db.transaction(UPDATES, 'readwrite');
      tx.objectStore(UPDATES).add(value);
      await done(tx);
    });
    if (++this.size >= TRIM_SIZE) this.scheduleCompact();
  };

  private scheduleCompact(): void {
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null;
      this.enqueue(async (db) => {
        if (this.destroyed) return;
        await compact(db, this.context, this.doc, this);
        this.size = 1;
      });
    }, COMPACT_DELAY_MS);
  }

  /** Stops listening, lets queued writes finish and closes the database. */
  destroy = (): Promise<void> => {
    if (this.closed) return this.closed;
    this.destroyed = true;
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.doc.off('update', this.onUpdate);
    this.doc.off('destroy', this.destroy);
    this.closed = this.writes
      .then(() => this.whenSynced)
      .catch(() => undefined)
      .then(() => this.db?.close());
    return this.closed;
  };
}
