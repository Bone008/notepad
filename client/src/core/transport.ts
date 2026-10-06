import type { ClientMessage, ServerMessage } from '@notepad/shared';

export type TransportKind = 'ws' | 'http';
export type CloseReason = 'network' | 'timeout' | 'unauthorized' | 'closed' | 'error';

export interface TransportEvents {
  onMessage(msg: ServerMessage): void;
  /** Fired once, after the transport delivered `ready`. */
  onOpen(): void;
  /** Fired once for a connection that closed on its own (not after an explicit close()). */
  onClose(reason: CloseReason): void;
}

export interface TransportConfig {
  /** "" for same-origin, or e.g. "http://127.0.0.1:3000" in tests. */
  baseUrl: string;
  vaultId: string;
  token: string;
  /** Current cursor; read when a connection (or resync) starts. */
  since: () => number;
}

export interface Transport {
  readonly kind: TransportKind;
  connect(events: TransportEvents): void;
  send(msg: ClientMessage): void;
  close(): void;
}

export type TransportFactory = (cfg: TransportConfig) => Transport;

export type ConnectionState = 'offline' | 'connecting' | 'open' | 'unauthorized';

export interface ConnectionStatus {
  state: ConnectionState;
  kind: TransportKind | null;
}

export interface ConnectionOptions {
  /** null disables WebSocket entirely. */
  ws: TransportFactory | null;
  http: TransportFactory;
  forceHttp: () => boolean;
  onMessage: (msg: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Remembers a failed WebSocket probe across sessions (sessionStorage in the browser). */
  wsProbeMemory?: { get(): number | null; set(ts: number | null): void };
  /** Re-probe WebSocket this long after a failure. */
  wsRetryAfterMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_WS_RETRY_MS = 10 * 60_000;

/**
 * Keeps exactly one transport alive: WebSocket first, HTTP long-polling when WebSocket is
 * blocked or forced off. Reconnects with jittered exponential backoff.
 */
export class ConnectionManager {
  private transport: Transport | null = null;
  private running = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private wsFailedAt: number | null;
  status: ConnectionStatus = { state: 'offline', kind: null };

  constructor(
    private readonly cfg: TransportConfig,
    private readonly opts: ConnectionOptions,
  ) {
    this.wsFailedAt = opts.wsProbeMemory?.get() ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
    }
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    this.clearTimers();
    this.transport?.close();
    this.transport = null;
    this.setStatus({ state: 'offline', kind: null });
  }

  /** Drop the current connection and connect again immediately (e.g. after toggling HTTP mode). */
  reconnectNow(): void {
    if (!this.running) return;
    this.clearTimers();
    this.transport?.close();
    this.transport = null;
    this.attempt = 0;
    this.connect();
  }

  send(msg: ClientMessage): boolean {
    if (this.status.state !== 'open' || !this.transport) return false;
    this.transport.send(msg);
    return true;
  }

  private onOnline = (): void => {
    if (this.status.state !== 'open') this.reconnectNow();
  };

  private shouldUseWs(): boolean {
    if (!this.opts.ws || this.opts.forceHttp()) return false;
    if (this.wsFailedAt === null) return true;
    return Date.now() - this.wsFailedAt > (this.opts.wsRetryAfterMs ?? DEFAULT_WS_RETRY_MS);
  }

  private connect(): void {
    if (!this.running) return;
    const useWs = this.shouldUseWs();
    const factory = useWs ? this.opts.ws! : this.opts.http;
    const transport = factory(this.cfg);
    this.transport = transport;
    this.setStatus({ state: 'connecting', kind: transport.kind });
    let opened = false;

    transport.connect({
      onMessage: (m) => {
        if (this.transport === transport) this.opts.onMessage(m);
      },
      onOpen: () => {
        if (this.transport !== transport) return;
        opened = true;
        this.setStatus({ state: 'open', kind: transport.kind });
        this.stableTimer = setTimeout(() => {
          this.attempt = 0;
        }, 10_000);
      },
      onClose: (reason) => {
        if (this.transport !== transport) return;
        this.transport = null;
        this.clearTimers();
        if (reason === 'unauthorized') {
          this.setStatus({ state: 'unauthorized', kind: null });
          return;
        }
        if (transport.kind === 'ws' && !opened) {
          // WebSocket could not be established: remember and fall back to HTTP right away.
          this.wsFailedAt = Date.now();
          this.opts.wsProbeMemory?.set(this.wsFailedAt);
          this.setStatus({ state: 'offline', kind: null });
          this.connect();
          return;
        }
        this.setStatus({ state: 'offline', kind: null });
        this.scheduleReconnect();
      },
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const base = Math.min(this.opts.maxBackoffMs ?? 30_000, 1000 * 2 ** this.attempt);
    const delay = base * (0.5 + Math.random());
    this.attempt = Math.min(this.attempt + 1, 10);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.reconnectTimer = null;
    this.stableTimer = null;
  }

  private setStatus(s: ConnectionStatus): void {
    if (s.state === this.status.state && s.kind === this.status.kind) return;
    this.status = s;
    this.opts.onStatus(s);
  }
}
