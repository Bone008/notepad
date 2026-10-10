import * as Y from 'yjs';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
import { deriveVaultKeys, fromBase64Url, type VaultKeys } from '@notepad/shared';
import { HttpTransport } from './httpTransport.js';
import { LocalDocPersistence } from './localDoc.js';
import { EncryptedProvider, type SessionStatus } from './provider.js';
import { Observable } from './store.js';
import { SyncStore, deleteDatabase, docDbName, syncDbName } from './syncStore.js';
import { ConnectionManager, type TransportFactory } from './transport.js';
import { WsTransport } from './wsTransport.js';

export interface UserInfo {
  name: string;
  color: string;
}

/** Stable ids that survive a page refresh (per tab) and identify the device (per browser profile). */
export interface Identity {
  sessionId: string;
  deviceId: string;
}

function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function storedId(storage: Storage | undefined, key: string): string {
  try {
    const existing = storage?.getItem(key);
    if (existing) return existing;
    const id = randomId();
    storage?.setItem(key, id);
    return id;
  } catch {
    return randomId();
  }
}

export function browserIdentity(): Identity {
  const hasWindow = typeof window !== 'undefined';
  return {
    sessionId: storedId(hasWindow ? window.sessionStorage : undefined, 'notepad:sessionId'),
    deviceId: storedId(hasWindow ? window.localStorage : undefined, 'notepad:deviceId'),
  };
}

export interface SessionOptions {
  vaultId: string;
  keyB64: string;
  /** "" for same-origin. */
  baseUrl?: string;
  forceHttp: () => boolean;
  user: () => UserInfo;
  /** Defaults to ids kept in sessionStorage/localStorage; tests inject their own. */
  identity?: Identity;
  /** Prefix for IndexedDB database names; lets tests host several "devices" in one process. */
  storageNamespace?: string;
  transports?: { ws?: TransportFactory | null; http?: TransportFactory };
  flushDelayMs?: number;
  snapshotAfterUpdates?: number;
  snapshotDelayMs?: [number, number];
}

function wsProbeMemory(vaultId: string): { get(): number | null; set(ts: number | null): void } | undefined {
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') return undefined;
  const sessionStorage = window.sessionStorage;
  const key = `notepad:wsFailedAt:${vaultId}`;
  return {
    get() {
      const v = sessionStorage.getItem(key);
      return v ? Number(v) : null;
    },
    set(ts) {
      if (ts === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, String(ts));
    },
  };
}

/** One open vault on this device: Y.Doc + local persistence + awareness + encrypted sync. */
export class VaultSession {
  readonly vaultId: string;
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new Awareness(this.doc);
  readonly idb: LocalDocPersistence;
  readonly ready: Promise<void>;
  readonly status = new Observable<SessionStatus>({ state: 'offline', transport: null, pending: 0, peers: 1, quotaExceeded: false });
  keys!: VaultKeys;
  provider!: EncryptedProvider;
  connection!: ConnectionManager;
  private readonly store: SyncStore;
  private readonly opts: SessionOptions;
  private readonly identity: Identity;
  private destroyed = false;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.vaultId = opts.vaultId;
    this.identity = opts.identity ?? browserIdentity();
    const ns = opts.storageNamespace ?? '';
    this.idb = new LocalDocPersistence(docDbName(ns, opts.vaultId), this.doc);
    this.store = new SyncStore(syncDbName(ns, opts.vaultId));
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    this.keys = await deriveVaultKeys(this.opts.vaultId, fromBase64Url(this.opts.keyB64));
    await this.idb.whenSynced;
    if (this.destroyed) return;

    const connection = new ConnectionManager(
      {
        baseUrl: this.opts.baseUrl ?? '',
        vaultId: this.opts.vaultId,
        token: this.keys.authToken,
        since: () => this.provider.cursor,
      },
      {
        ws: this.opts.transports?.ws === undefined ? (cfg) => new WsTransport(cfg) : this.opts.transports.ws,
        http: this.opts.transports?.http ?? ((cfg) => new HttpTransport(cfg)),
        forceHttp: this.opts.forceHttp,
        onMessage: (m) => this.provider.onMessage(m),
        onStatus: (s) => this.provider.onConnectionStatus(s),
        wsProbeMemory: wsProbeMemory(this.opts.vaultId),
      },
    );
    this.connection = connection;

    this.provider = new EncryptedProvider({
      doc: this.doc,
      awareness: this.awareness,
      keys: this.keys,
      store: this.store,
      sender: { send: (m) => connection.send(m) },
      ignoredOrigins: [this.idb],
      status: this.status,
      flushDelayMs: this.opts.flushDelayMs,
      snapshotAfterUpdates: this.opts.snapshotAfterUpdates,
      snapshotDelayMs: this.opts.snapshotDelayMs,
    });
    this.provider.onResyncNeeded = () => connection.reconnectNow();
    await this.provider.init();
    if (this.destroyed) return;

    this.setUser(this.opts.user());
    connection.start();
  }

  /** (Re)publishes this tab's presence; also used to come back after leavePresence(). */
  setUser(u: UserInfo): void {
    this.awareness.setLocalStateField('user', {
      name: u.name,
      color: u.color,
      colorLight: u.color + '55',
      sessionId: this.identity.sessionId,
      deviceId: this.identity.deviceId,
    });
  }

  announce(): void {
    this.setUser(this.opts.user());
  }

  reconnect(): void {
    this.connection?.reconnectNow();
  }

  /**
   * Best-effort "I left" for page unload. The frame goes out over the live connection and, since
   * that socket is usually torn down mid-unload, also via sendBeacon. If both are lost, the
   * refreshed tab recognises its own stale entry by sessionId and removes it (see provider).
   */
  async leavePresence(): Promise<void> {
    if (!this.provider || !this.keys) return;
    const blob = await this.provider.encodeLeave();
    this.connection?.send({ t: 'awareness', blob });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const url = `${this.opts.baseUrl ?? ''}/api/vaults/${this.vaultId}/awareness`;
      navigator.sendBeacon(url, new Blob([JSON.stringify({ token: this.keys.authToken, blob })], { type: 'application/json' }));
    }
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
  }

  /** Resolves once pending local writes are flushed and the database is closed. */
  destroy(): Promise<void> {
    if (this.destroyed) return this.idb.destroy();
    this.destroyed = true;
    this.connection?.stop();
    this.provider?.destroy();
    this.awareness.destroy();
    const closed = this.idb.destroy();
    this.doc.destroy();
    return closed;
  }

  /** Remove every local trace of this vault (leave vault). */
  async wipeLocal(): Promise<void> {
    const ns = this.opts.storageNamespace ?? '';
    await this.destroy();
    await deleteDatabase(docDbName(ns, this.vaultId));
    await deleteDatabase(syncDbName(ns, this.vaultId));
  }
}
