import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { LIMITS, WS_PATH, parseClientMessage, type ServerMessage } from '@notepad/shared';
import { authorizeVault } from './auth.js';
import type { Config } from './config.js';
import { QuotaError, type Repo } from './db.js';
import type { RoomClient, Rooms } from './rooms.js';
import { buildState } from './routes/vaults.js';

export interface WsDeps {
  config: Config;
  repo: Repo;
  rooms: Rooms;
}

const HEARTBEAT_MS = 30_000;

export function attachWebSocket(server: Server, { config, repo, rooms }: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.ceil((config.maxSnapshotBytes * 4) / 3) + 4096,
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    let vaultId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let alive = true;

    const client: RoomClient = {
      send(msg: ServerMessage) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    const fail = (code: 'unauthorized' | 'bad_request', close = true): void => {
      client.send({ t: 'error', code });
      if (close) ws.close(code === 'unauthorized' ? 4401 : 4400);
    };

    const authTimer = setTimeout(() => {
      if (!vaultId) ws.close(4408, 'auth timeout');
    }, LIMITS.wsAuthTimeoutMs);

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('pong', () => {
      alive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return fail('bad_request');
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return fail('bad_request');
      }
      const msg = parseClientMessage(raw);
      if (!msg) return fail('bad_request', false);

      if (!vaultId) {
        if (msg.t !== 'auth') return fail('unauthorized');
        const vault = authorizeVault(repo, msg.vaultId, msg.token);
        if (!vault) return fail('unauthorized');
        vaultId = vault.id;
        clearTimeout(authTimer);
        // Subscribe BEFORE reading the backlog so nothing committed in between is missed;
        // the client dedupes by seq.
        unsubscribe = rooms.subscribe(vaultId, client);
        const st = buildState(repo, vaultId, msg.since);
        client.send({
          t: 'ready',
          head: st.head,
          snapshotSeq: st.snapshotSeq,
          oldestSeq: st.oldestSeq,
          updatesSinceSnapshot: st.updatesSinceSnapshot,
        });
        if (st.snapshot) client.send({ t: 'snapshot', seq: st.snapshot.seq, blob: st.snapshot.blob });
        for (const u of st.updates) client.send({ t: 'update', seq: u.seq, blob: u.blob });
        // Recent presence frames so the newcomer sees who is already here without waiting for heartbeats.
        for (const blob of rooms.awarenessSince(vaultId, 0).blobs) client.send({ t: 'awareness', blob });
        return;
      }

      switch (msg.t) {
        case 'auth':
          return fail('bad_request', false);
        case 'ping':
          return client.send({ t: 'pong' });
        case 'update': {
          const bytes = Buffer.from(msg.blob, 'base64url');
          if (bytes.byteLength > config.maxUpdateBytes) return client.send({ t: 'error', code: 'too_large' });
          let seq: number;
          try {
            seq = repo.appendUpdate(vaultId, bytes, config.vaultQuotaBytes);
          } catch (e) {
            if (e instanceof QuotaError) return client.send({ t: 'error', code: 'quota' });
            throw e;
          }
          rooms.broadcastUpdate(vaultId, seq, msg.blob, client);
          const st = repo.getState(vaultId);
          return client.send({ t: 'ack', id: msg.id, seq, head: st.head, updatesSinceSnapshot: st.updatesSinceSnapshot });
        }
        case 'awareness': {
          const bytes = Buffer.from(msg.blob, 'base64url');
          if (bytes.byteLength > config.maxAwarenessBytes) return client.send({ t: 'error', code: 'too_large' });
          rooms.publishAwareness(vaultId, msg.blob, client);
          return;
        }
        case 'snapshot': {
          const bytes = Buffer.from(msg.blob, 'base64url');
          if (bytes.byteLength > config.maxSnapshotBytes) return client.send({ t: 'error', code: 'too_large' });
          if (msg.baseSeq === 0 || !repo.storeSnapshot(vaultId, bytes, msg.baseSeq)) {
            return client.send({ t: 'error', code: 'conflict' });
          }
          return client.send({ t: 'snapshot_ack', snapshotSeq: msg.baseSeq });
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      unsubscribe?.();
    });
    ws.on('error', () => ws.terminate());
  });

  return wss;
}
