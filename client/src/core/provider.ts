import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import {
  LIMITS,
  decryptFrame,
  encryptFrame,
  frameAad,
  fromBase64Url,
  toBase64Url,
  type ServerMessage,
  type VaultKeys,
} from '@notepad/shared';
import { Observable } from './store.js';
import type { SyncStore } from './syncStore.js';
import type { ConnectionStatus, TransportKind } from './transport.js';

export type SyncState = 'offline' | 'connecting' | 'syncing' | 'synced' | 'unauthorized' | 'wrongKey';

export interface SessionStatus {
  state: SyncState;
  transport: TransportKind | null;
  /** Local updates not yet acknowledged by the server. */
  pending: number;
  /** Devices currently present (including this one). */
  peers: number;
  /** Set when the server rejected a push because the vault is full. */
  quotaExceeded: boolean;
}

export interface Sender {
  send(msg: { t: 'update'; id: string; blob: string } | { t: 'awareness'; blob: string } | { t: 'snapshot'; blob: string; baseSeq: number }): boolean;
}

export interface ProviderOptions {
  doc: Y.Doc;
  awareness: Awareness;
  keys: VaultKeys;
  store: SyncStore;
  sender: Sender;
  /** Origins whose updates are NOT local edits (e.g. the local IndexedDB persistence). */
  ignoredOrigins: unknown[];
  /** Optional externally owned status observable (the session creates one before the provider exists). */
  status?: Observable<SessionStatus>;
  /** Debounce for batching local edits before pushing. */
  flushDelayMs?: number;
  /** Random delay range before volunteering a snapshot. */
  snapshotDelayMs?: [number, number];
  snapshotAfterUpdates?: number;
}

interface AwarenessUser {
  name?: string;
  color?: string;
  sessionId?: string;
  deviceId?: string;
}

export function userOf(state: unknown): AwarenessUser | undefined {
  const u = (state as { user?: unknown } | null | undefined)?.user;
  return typeof u === 'object' && u !== null ? (u as AwarenessUser) : undefined;
}

const EMPTY_UPDATE_LENGTH = 2; // Y.encodeStateAsUpdate of "nothing new" is [0, 0]

function isEmptyUpdate(u: Uint8Array): boolean {
  return u.length <= EMPTY_UPDATE_LENGTH;
}

/**
 * Bridges a local Y.Doc with the encrypted append-only log on the server.
 *
 * Invariants:
 *  - every incoming frame is decrypted and applied in seq order; `lastSeq` only moves forward;
 *  - local edits enter `outbox` and leave it only on ack;
 *  - `syncedSV` is recorded only when the outbox is empty and catch-up is finished, so that
 *    `encodeStateAsUpdate(doc, syncedSV)` at startup is a safe "what the server might lack" diff.
 */
export class EncryptedProvider {
  readonly status: Observable<SessionStatus>;
  private lastSeq = 0;
  private syncedSV: Uint8Array | null = null;
  private outbox: Uint8Array[] = [];
  private inflight: { id: string; count: number } | null = null;
  private ownSeqs = new Set<number>();
  private serverHead = 0;
  private updatesSinceSnapshot = 0;
  private connection: ConnectionStatus = { state: 'offline', kind: null };
  private chain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessDirty = new Set<number>();
  private resyncRequested = false;
  private destroyed = false;
  private wrongKey = false;
  private quotaExceeded = false;
  private readonly doc: Y.Doc;
  private readonly awareness: Awareness;
  private readonly keys: VaultKeys;
  private readonly store: SyncStore;
  private readonly sender: Sender;
  private readonly ignoredOrigins: unknown[];
  private readonly flushDelayMs: number;
  private readonly snapshotDelayMs: [number, number];
  private readonly snapshotAfterUpdates: number;
  /** Called by the session when the provider wants a fresh connection (e.g. after a seq gap). */
  onResyncNeeded: (() => void) | null = null;

  constructor(opts: ProviderOptions) {
    this.doc = opts.doc;
    this.awareness = opts.awareness;
    this.keys = opts.keys;
    this.store = opts.store;
    this.sender = opts.sender;
    this.ignoredOrigins = opts.ignoredOrigins;
    this.flushDelayMs = opts.flushDelayMs ?? 100;
    this.snapshotDelayMs = opts.snapshotDelayMs ?? [5000, 30_000];
    this.snapshotAfterUpdates = opts.snapshotAfterUpdates ?? LIMITS.snapshotAfterUpdates;
    this.status =
      opts.status ??
      new Observable<SessionStatus>({
        state: 'offline',
        transport: null,
        pending: 0,
        peers: this.awareness.getStates().size,
        quotaExceeded: false,
      });
  }

  get cursor(): number {
    return this.lastSeq;
  }

  get pendingCount(): number {
    return this.outbox.length;
  }

  /** Load persisted sync state and start tracking local edits. Call after the local document has loaded. */
  async init(): Promise<void> {
    const st = await this.store.load();
    this.lastSeq = st.lastSeq;
    this.syncedSV = st.syncedSV;
    this.outbox = st.outbox;

    // Safety net: anything in the doc that the server did not have at the last clean sync point.
    // Covers edits persisted locally but lost from the outbox (two separate IndexedDB writes).
    if (this.syncedSV) {
      const diff = Y.encodeStateAsUpdate(this.doc, this.syncedSV);
      if (!isEmptyUpdate(diff)) {
        this.outbox.push(diff);
        void this.persistOutbox();
      }
    } else if (this.outbox.length === 0 && this.lastSeq === 0) {
      // Never synced before: whatever is in the doc (e.g. the creator's initial file) must be pushed.
      const full = Y.encodeStateAsUpdate(this.doc);
      if (!isEmptyUpdate(full)) {
        this.outbox.push(full);
        void this.persistOutbox();
      }
    }

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.publishStatus();
  }

  destroy(): void {
    this.destroyed = true;
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
  }

  // ---- connection lifecycle -------------------------------------------------

  onConnectionStatus(status: ConnectionStatus): void {
    const wasOpen = this.connection.state === 'open';
    this.connection = status;
    if (status.state !== 'open') {
      // Anything in flight may or may not have been committed; resend after reconnect (idempotent).
      this.inflight = null;
      if (wasOpen) this.resyncRequested = false;
    } else {
      this.sendAwareness([this.awareness.clientID]);
      this.afterProgress();
    }
    this.publishStatus();
  }

  /** Entry point for every server message; processing is serialized to keep seq order. */
  onMessage(msg: ServerMessage): void {
    this.chain = this.chain.then(() => this.handle(msg)).catch((e) => console.error('[notepad] sync error', e));
  }

  // ---- message handling -----------------------------------------------------

  private async handle(msg: ServerMessage): Promise<void> {
    if (this.destroyed) return;
    switch (msg.t) {
      case 'ready':
        return this.handleReady(msg.head, msg.updatesSinceSnapshot);
      case 'snapshot':
        return this.handleSnapshot(msg.seq, msg.blob);
      case 'update':
        return this.handleUpdate(msg.seq, msg.blob);
      case 'awareness':
        return this.handleAwareness(msg.blob);
      case 'ack':
        return this.handleAck(msg.id, msg.seq, msg.head, msg.updatesSinceSnapshot);
      case 'snapshot_ack':
        this.updatesSinceSnapshot = Math.max(0, this.serverHead - msg.snapshotSeq);
        return;
      case 'error':
        return this.handleError(msg.code);
      case 'pong':
        return;
    }
  }

  private async handleReady(head: number, updatesSinceSnapshot: number): Promise<void> {
    this.serverHead = head;
    this.updatesSinceSnapshot = updatesSinceSnapshot;
    this.ownSeqs.clear();
    if (head < this.lastSeq) {
      // The server knows less than we do (data reset or a different server): re-upload everything.
      this.lastSeq = 0;
      this.syncedSV = null;
      this.outbox = [Y.encodeStateAsUpdate(this.doc)];
      await Promise.all([this.store.setLastSeq(0), this.store.setSyncedSV(null), this.persistOutbox()]);
    }
    this.afterProgress();
  }

  private async handleSnapshot(seq: number, blob: string): Promise<void> {
    let pt: Uint8Array;
    try {
      pt = await decryptFrame(this.keys.contentKey, frameAad(this.keys.vaultId, 'snapshot'), fromBase64Url(blob));
    } catch {
      this.wrongKey = true;
      this.publishStatus();
      return;
    }
    Y.applyUpdate(this.doc, pt, this);
    if (seq > this.lastSeq) await this.setLastSeq(seq);
    this.afterProgress();
  }

  private async handleUpdate(seq: number, blob: string): Promise<void> {
    if (seq <= this.lastSeq) return; // duplicate (echo or subscribe/backlog overlap)
    if (seq > this.lastSeq + 1 && !this.ownSeqs.has(this.lastSeq + 1)) {
      // A gap we cannot explain: fetch the log again from our cursor.
      this.requestResync();
      return;
    }
    let pt: Uint8Array;
    try {
      pt = await decryptFrame(this.keys.contentKey, frameAad(this.keys.vaultId, 'update'), fromBase64Url(blob));
    } catch (e) {
      console.warn('[notepad] dropping undecryptable update', seq, e);
      await this.setLastSeq(seq);
      this.afterProgress();
      return;
    }
    Y.applyUpdate(this.doc, pt, this);
    await this.setLastSeq(seq);
    this.afterProgress();
  }

  private async handleAwareness(blob: string): Promise<void> {
    try {
      const pt = await decryptFrame(this.keys.contentKey, frameAad(this.keys.vaultId, 'awareness'), fromBase64Url(blob));
      applyAwarenessUpdate(this.awareness, pt, this);
      this.dropStaleSelf();
    } catch {
      /* ephemeral; ignore */
    }
    this.publishStatus();
  }

  /**
   * After a page refresh this tab has a new Yjs client id, but the previous one may still be
   * known to the server's presence buffer and to peers. Entries carrying our own sessionId under
   * another client id are therefore ours and stale: remove them and broadcast the removal.
   */
  private dropStaleSelf(): void {
    const mine = userOf(this.awareness.getLocalState())?.sessionId;
    if (!mine) return;
    const stale: number[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId !== this.awareness.clientID && userOf(state)?.sessionId === mine) stale.push(clientId);
    });
    if (stale.length > 0) removeAwarenessStates(this.awareness, stale, 'stale-self');
  }

  private async handleAck(id: string, seq: number, head: number, updatesSinceSnapshot: number): Promise<void> {
    this.serverHead = Math.max(this.serverHead, head);
    this.updatesSinceSnapshot = updatesSinceSnapshot;
    this.ownSeqs.add(seq);
    if (this.inflight && this.inflight.id === id) {
      this.outbox.splice(0, this.inflight.count);
      this.inflight = null;
      await this.persistOutbox();
    }
    await this.advanceOverOwnSeqs();
    this.afterProgress();
  }

  private handleError(code: string): void {
    if (code === 'quota' || code === 'too_large') {
      this.quotaExceeded = code === 'quota';
      this.inflight = null;
      if (code === 'too_large' && this.outbox.length > 1) {
        // Retry with smaller batches: send entries one at a time.
        this.splitLarge = true;
        this.scheduleFlush();
      }
      this.publishStatus();
    } else if (code === 'conflict') {
      this.snapshotPending = false;
    } else if (code === 'resync') {
      this.requestResync();
    }
  }

  private splitLarge = false;
  private snapshotPending = false;

  // ---- local edits ----------------------------------------------------------

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || this.ignoredOrigins.includes(origin)) return;
    this.outbox.push(update);
    void this.persistOutbox();
    this.scheduleFlush();
    this.publishStatus();
  };

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDelayMs);
  }

  private flush(): void {
    if (this.destroyed || this.connection.state !== 'open' || this.inflight || this.outbox.length === 0) return;
    if (this.catchingUp()) return;
    const count = this.splitLarge ? 1 : this.outbox.length;
    const merged = count === 1 ? this.outbox[0]! : Y.mergeUpdates(this.outbox.slice(0, count));
    const id = Math.random().toString(36).slice(2, 12);
    this.inflight = { id, count };
    void encryptFrame(this.keys.contentKey, frameAad(this.keys.vaultId, 'update'), merged).then((frame) => {
      if (this.destroyed || !this.inflight || this.inflight.id !== id) return;
      if (!this.sender.send({ t: 'update', id, blob: toBase64Url(frame) })) this.inflight = null;
    });
  }

  private catchingUp(): boolean {
    return this.lastSeq < this.serverHead;
  }

  /** Called after any progress: flush, record clean sync point, maybe snapshot, publish status. */
  private afterProgress(): void {
    if (this.destroyed) return;
    if (this.catchingUp()) {
      this.publishStatus();
      return;
    }
    if (this.outbox.length > 0) {
      this.scheduleFlush();
    } else if (!this.inflight && this.connection.state === 'open') {
      const sv = Y.encodeStateVector(this.doc);
      this.syncedSV = sv;
      void this.store.setSyncedSV(sv);
      this.maybeScheduleSnapshot();
    }
    this.publishStatus();
  }

  private async advanceOverOwnSeqs(): Promise<void> {
    let moved = false;
    while (this.ownSeqs.has(this.lastSeq + 1)) {
      this.ownSeqs.delete(this.lastSeq + 1);
      this.lastSeq += 1;
      moved = true;
    }
    if (moved) await this.store.setLastSeq(this.lastSeq);
  }

  private async setLastSeq(seq: number): Promise<void> {
    this.lastSeq = seq;
    await this.advanceOverOwnSeqs();
    await this.store.setLastSeq(this.lastSeq);
  }

  private persistOutbox(): Promise<void> {
    return this.store.setOutbox(this.outbox).catch((e) => console.error('[notepad] outbox persist failed', e));
  }

  private requestResync(): void {
    if (this.resyncRequested) return;
    this.resyncRequested = true;
    this.onResyncNeeded?.();
  }

  // ---- snapshots ------------------------------------------------------------

  private maybeScheduleSnapshot(): void {
    if (this.snapshotPending || this.snapshotTimer || this.updatesSinceSnapshot <= this.snapshotAfterUpdates) return;
    const [lo, hi] = this.snapshotDelayMs;
    this.snapshotTimer = setTimeout(
      () => {
        this.snapshotTimer = null;
        void this.trySnapshot();
      },
      lo + Math.random() * (hi - lo),
    );
  }

  private async trySnapshot(): Promise<void> {
    if (
      this.destroyed ||
      this.connection.state !== 'open' ||
      this.catchingUp() ||
      this.outbox.length > 0 ||
      this.inflight ||
      this.updatesSinceSnapshot <= this.snapshotAfterUpdates
    ) {
      return;
    }
    const baseSeq = this.lastSeq;
    const full = Y.encodeStateAsUpdate(this.doc);
    const frame = await encryptFrame(this.keys.contentKey, frameAad(this.keys.vaultId, 'snapshot'), full);
    this.snapshotPending = true;
    if (!this.sender.send({ t: 'snapshot', blob: toBase64Url(frame), baseSeq })) this.snapshotPending = false;
    // snapshot_ack / conflict clear snapshotPending via handle().
    setTimeout(() => {
      this.snapshotPending = false;
    }, 60_000);
  }

  // ---- awareness ------------------------------------------------------------

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) {
      // A peer we did not know about appeared: make sure it learns about us too.
      if (added.length > 0) this.sendAwareness([this.awareness.clientID]);
      this.publishStatus();
      return;
    }
    for (const c of [...added, ...updated, ...removed]) this.awarenessDirty.add(c);
    if (!this.awarenessTimer) {
      this.awarenessTimer = setTimeout(() => {
        this.awarenessTimer = null;
        const clients = [...this.awarenessDirty];
        this.awarenessDirty.clear();
        this.sendAwareness(clients);
      }, 150);
    }
    this.publishStatus();
  };

  private sendAwareness(clients: number[]): void {
    if (this.destroyed || this.connection.state !== 'open' || clients.length === 0) return;
    const update = encodeAwarenessUpdate(this.awareness, clients);
    void encryptFrame(this.keys.contentKey, frameAad(this.keys.vaultId, 'awareness'), update).then((frame) => {
      if (this.destroyed) return;
      this.sender.send({ t: 'awareness', blob: toBase64Url(frame) });
    });
  }

  /** Encrypted "I am leaving" message, for sendBeacon on page hide. */
  async encodeLeave(): Promise<string> {
    const update = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID], new Map());
    const frame = await encryptFrame(this.keys.contentKey, frameAad(this.keys.vaultId, 'awareness'), update);
    return toBase64Url(frame);
  }

  // ---- status ---------------------------------------------------------------

  private publishStatus(): void {
    let state: SyncState;
    if (this.wrongKey) state = 'wrongKey';
    else if (this.connection.state === 'unauthorized') state = 'unauthorized';
    else if (this.connection.state === 'offline') state = 'offline';
    else if (this.connection.state === 'connecting') state = 'connecting';
    else if (this.catchingUp() || this.outbox.length > 0 || this.inflight) state = 'syncing';
    else state = 'synced';
    this.status.set({
      state,
      transport: this.connection.kind,
      pending: this.outbox.length,
      peers: this.awareness.getStates().size,
      quotaExceeded: this.quotaExceeded,
    });
  }
}
