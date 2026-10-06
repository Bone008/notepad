import type {
  ClientMessage,
  EventsResponse,
  PostUpdatesResponse,
  ServerMessage,
  StateResponse,
} from '@notepad/shared';
import type { CloseReason, Transport, TransportConfig, TransportEvents } from './transport.js';

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`http ${status}`);
  }
}

/**
 * Long-polling transport for networks where WebSockets are blocked. Emits the same
 * ServerMessage stream as the WebSocket transport, so the provider has one code path.
 */
export class HttpTransport implements Transport {
  readonly kind = 'http' as const;
  private ev: TransportEvents | null = null;
  private alive = false;
  private cursor = 0;
  private awTick = 0;
  private pollAbort: AbortController | null = null;
  private pending = new Set<AbortController>();

  constructor(
    private readonly cfg: TransportConfig,
    private readonly waitMs = 25_000,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  connect(ev: TransportEvents): void {
    this.ev = ev;
    this.alive = true;
    void this.run();
  }

  send(msg: ClientMessage): void {
    if (!this.alive) return;
    switch (msg.t) {
      case 'update':
        void this.postUpdate(msg.id, msg.blob);
        return;
      case 'awareness':
        void this.request('POST', '/awareness', { blob: msg.blob }).catch(() => undefined);
        return;
      case 'snapshot':
        void this.postSnapshot(msg.blob, msg.baseSeq);
        return;
      case 'ping':
      case 'auth':
        return;
    }
  }

  close(): void {
    this.alive = false;
    this.pollAbort?.abort();
    for (const ac of this.pending) ac.abort();
  }

  // ---- internals ------------------------------------------------------------

  private url(path: string): string {
    return `${this.cfg.baseUrl}/api/vaults/${this.cfg.vaultId}${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const ac = new AbortController();
    this.pending.add(ac);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url(path), {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        let parsed: unknown = null;
        try {
          parsed = await res.json();
        } catch {
          /* ignore */
        }
        throw new HttpError(res.status, parsed);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
      this.pending.delete(ac);
    }
  }

  private async run(): Promise<void> {
    try {
      const st = await this.requestState();
      if (!this.alive) return;
      this.ev?.onOpen();
      this.emitState(st);
      await this.pollLoop();
    } catch (e) {
      this.fail(e);
    }
  }

  private async requestState(): Promise<StateResponse> {
    const since = this.cfg.since();
    const st = await this.request<StateResponse>('GET', `/state?since=${since}`);
    this.cursor = since;
    return st;
  }

  private emitState(st: StateResponse): void {
    this.emit({
      t: 'ready',
      head: st.head,
      snapshotSeq: st.snapshotSeq,
      oldestSeq: st.oldestSeq,
      updatesSinceSnapshot: st.updatesSinceSnapshot,
    });
    if (st.snapshot) {
      this.emit({ t: 'snapshot', seq: st.snapshot.seq, blob: st.snapshot.blob });
      this.cursor = Math.max(this.cursor, st.snapshot.seq);
    }
    for (const u of st.updates) {
      this.emit({ t: 'update', seq: u.seq, blob: u.blob });
      this.cursor = Math.max(this.cursor, u.seq);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.alive) {
      const ac = new AbortController();
      this.pollAbort = ac;
      const timer = setTimeout(() => ac.abort(), this.waitMs + 15_000);
      try {
        const res = await this.fetchImpl(this.url(`/events?since=${this.cursor}&awSince=${this.awTick}&wait=${this.waitMs}`), {
          headers: { Authorization: `Bearer ${this.cfg.token}` },
          signal: ac.signal,
          cache: 'no-store',
        });
        if (res.status === 409) {
          this.emitState(await this.requestState());
          continue;
        }
        if (!res.ok) throw new HttpError(res.status, null);
        const body = (await res.json()) as EventsResponse;
        for (const u of body.updates) {
          if (u.seq > this.cursor) {
            this.emit({ t: 'update', seq: u.seq, blob: u.blob });
            this.cursor = u.seq;
          }
        }
        for (const a of body.awareness) this.emit({ t: 'awareness', blob: a });
        this.awTick = Math.max(this.awTick, body.awTick);
      } finally {
        clearTimeout(timer);
        if (this.pollAbort === ac) this.pollAbort = null;
      }
    }
  }

  private async postUpdate(id: string, blob: string): Promise<void> {
    try {
      const res = await this.request<PostUpdatesResponse>('POST', '/updates', { updates: [{ id, blob }] });
      for (const a of res.acks) {
        this.emit({ t: 'ack', id: a.id, seq: a.seq, head: res.head, updatesSinceSnapshot: res.updatesSinceSnapshot });
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 413) {
        const code = (e.body as { error?: string } | null)?.error === 'quota' ? 'quota' : 'too_large';
        this.emit({ t: 'error', code });
        return;
      }
      this.fail(e);
    }
  }

  private async postSnapshot(blob: string, baseSeq: number): Promise<void> {
    try {
      const res = await this.request<{ snapshotSeq: number }>('POST', '/snapshot', { blob, baseSeq }, 60_000);
      this.emit({ t: 'snapshot_ack', snapshotSeq: res.snapshotSeq });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 409 || e.status === 413)) {
        this.emit({ t: 'error', code: e.status === 409 ? 'conflict' : 'too_large' });
        return;
      }
      this.fail(e);
    }
  }

  private emit(msg: ServerMessage): void {
    if (this.alive) this.ev?.onMessage(msg);
  }

  private fail(e: unknown): void {
    if (!this.alive) return;
    this.alive = false;
    this.pollAbort?.abort();
    for (const ac of this.pending) ac.abort();
    let reason: CloseReason = 'network';
    if (e instanceof HttpError && e.status === 401) reason = 'unauthorized';
    else if (e instanceof HttpError) reason = 'error';
    this.ev?.onClose(reason);
  }
}
