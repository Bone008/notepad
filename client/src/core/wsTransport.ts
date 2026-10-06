import { WS_PATH, type ClientMessage, type ServerMessage } from '@notepad/shared';
import type { CloseReason, Transport, TransportConfig, TransportEvents } from './transport.js';

export function wsUrl(baseUrl: string): string {
  const origin = baseUrl || (typeof location !== 'undefined' ? location.origin : '');
  return origin.replace(/^http/, 'ws') + WS_PATH;
}

export class WsTransport implements Transport {
  readonly kind = 'ws' as const;
  private ws: WebSocket | null = null;
  private opened = false;
  private done = false;
  private reason: CloseReason | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cfg: TransportConfig,
    private readonly openTimeoutMs = 4000,
    private readonly WebSocketImpl: typeof WebSocket = globalThis.WebSocket,
  ) {}

  connect(ev: TransportEvents): void {
    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(wsUrl(this.cfg.baseUrl));
    } catch {
      queueMicrotask(() => this.finish(ev, 'error'));
      return;
    }
    this.ws = ws;
    this.timer = setTimeout(() => {
      if (!this.opened) {
        this.reason = 'timeout';
        ws.close();
      }
    }, this.openTimeoutMs);

    ws.onopen = () => {
      const auth: ClientMessage = { t: 'auth', vaultId: this.cfg.vaultId, token: this.cfg.token, since: this.cfg.since() };
      ws.send(JSON.stringify(auth));
    };
    ws.onmessage = (e: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'error' && msg.code === 'unauthorized') this.reason = 'unauthorized';
      if (msg.t === 'ready' && !this.opened) {
        this.opened = true;
        if (this.timer) clearTimeout(this.timer);
        ev.onOpen();
      }
      ev.onMessage(msg);
    };
    ws.onerror = () => {
      /* onclose always follows */
    };
    ws.onclose = () => this.finish(ev, this.reason ?? (this.opened ? 'closed' : 'network'));
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    }
  }

  private finish(ev: TransportEvents, reason: CloseReason): void {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws = null;
    ev.onClose(reason);
  }
}
