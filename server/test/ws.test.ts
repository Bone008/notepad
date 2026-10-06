import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, toBase64Url, type ClientMessage, type ServerMessage } from '@notepad/shared';
import { hashToken } from '../src/auth.js';
import type { App } from '../src/app.js';
import { blob, listen, makeApp, newVaultCreds, type TestVault } from './helpers.js';

let app: App;
let port: number;
beforeAll(async () => {
  app = makeApp();
  port = await listen(app);
});
afterAll(async () => {
  await app.close();
});

class Client {
  ws: WebSocket;
  closed: Promise<number>;
  private queue: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => void)[] = [];
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.closed = new Promise<number>((resolve) => this.ws.on('close', (code) => resolve(code)));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
  }
  open(): Promise<void> {
    return new Promise((r) => this.ws.once('open', () => r()));
  }
  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }
  next(timeoutMs = 2000): Promise<ServerMessage> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }
  async auth(v: TestVault, since = 0): Promise<ServerMessage> {
    await this.open();
    this.send({ t: 'auth', vaultId: v.id, token: v.token, since });
    return this.next();
  }
}

function createVault(): TestVault {
  const v = newVaultCreds();
  expect(app.repo.createVault(v.id, hashToken(v.token))).toBe(true);
  return v;
}

describe('websocket', () => {
  it('rejects bad auth', async () => {
    const v = createVault();
    const c = new Client();
    const m = await c.auth({ id: v.id, token: toBase64Url(randomBytes(32)) });
    expect(m).toEqual({ t: 'error', code: 'unauthorized' });
    expect(await c.closed).toBe(4401);
  });

  it('upgrades only on /ws', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    const err = await new Promise<Error>((r) => ws.on('error', r));
    expect(err).toBeTruthy();
  });

  it('sends ready + backlog, acks updates, relays to peers, answers ping', async () => {
    const v = createVault();
    app.repo.appendUpdate(v.id, Buffer.from(blob(10, 1), 'base64url'), 1e9);

    const a = new Client();
    expect(await a.auth(v)).toMatchObject({ t: 'ready', head: 1, snapshotSeq: 0, oldestSeq: 1 });
    expect(await a.next()).toEqual({ t: 'update', seq: 1, blob: blob(10, 1) });

    const b = new Client();
    expect(await b.auth(v, 1)).toMatchObject({ t: 'ready', head: 1 });

    a.send({ t: 'update', id: 'x', blob: blob(12, 2) });
    expect(await a.next()).toMatchObject({ t: 'ack', id: 'x', seq: 2, head: 2 });
    expect(await b.next()).toEqual({ t: 'update', seq: 2, blob: blob(12, 2) });

    b.send({ t: 'awareness', blob: blob(6, 3) });
    expect(await a.next()).toEqual({ t: 'awareness', blob: blob(6, 3) });

    a.send({ t: 'ping' });
    expect(await a.next()).toEqual({ t: 'pong' });

    a.send({ t: 'snapshot', blob: blob(50, 4), baseSeq: 2 });
    expect(await a.next()).toEqual({ t: 'snapshot_ack', snapshotSeq: 2 });
    expect(app.repo.getState(v.id)).toMatchObject({ head: 2, snapshotSeq: 2, oldestSeq: 3 });

    // Late joiner from scratch receives the snapshot instead of the compacted log.
    const c = new Client();
    expect(await c.auth(v, 0)).toMatchObject({ t: 'ready', head: 2, snapshotSeq: 2 });
    expect(await c.next()).toEqual({ t: 'snapshot', seq: 2, blob: blob(50, 4) });
    // ...and the presence frames published before it joined.
    expect(await c.next()).toEqual({ t: 'awareness', blob: blob(6, 3) });

    // Oversize update is refused.
    a.send({ t: 'update', id: 'big', blob: blob(3000) });
    expect(await a.next()).toEqual({ t: 'error', code: 'too_large' });

    a.ws.close();
    b.ws.close();
    c.ws.close();
    await Promise.all([a.closed, b.closed, c.closed]);
  });

  it('rejects malformed frames without dropping the connection', async () => {
    const v = createVault();
    const a = new Client();
    await a.auth(v);
    a.ws.send('{"t":"update"}');
    expect(await a.next()).toEqual({ t: 'error', code: 'bad_request' });
    a.send({ t: 'ping' });
    expect(await a.next()).toEqual({ t: 'pong' });
    a.ws.close();
    await a.closed;
  });
});
