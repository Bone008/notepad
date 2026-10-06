import express, { Router, type Request, type Response } from 'express';
import {
  LIMITS,
  isAuthToken,
  isAwarenessBlob,
  isSeq,
  isSnapshotBlob,
  isUpdateBlob,
  isVaultId,
  type EventsResponse,
  type PostUpdatesResponse,
  type StateResponse,
} from '@notepad/shared';
import { hashToken, requireVault, secretsEqual, type VaultLocals } from '../auth.js';
import type { Config } from '../config.js';
import { QuotaError, type Repo } from '../db.js';
import type { Limiters } from '../limits.js';
import type { Rooms } from '../rooms.js';

export interface VaultDeps {
  config: Config;
  repo: Repo;
  rooms: Rooms;
  limiters: Limiters;
}

const b64 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64url');
const fromB64 = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Shared by GET /state and the WebSocket auth handshake. */
export function buildState(repo: Repo, vaultId: string, since: number): StateResponse {
  const st = repo.getState(vaultId);
  const out: StateResponse = {
    head: st.head,
    snapshotSeq: st.snapshotSeq,
    oldestSeq: st.oldestSeq,
    updatesSinceSnapshot: st.updatesSinceSnapshot,
    updates: [],
  };
  let from = since;
  if (since + 1 < st.oldestSeq) {
    const snap = repo.getLatestSnapshot(vaultId);
    if (snap) {
      out.snapshot = { seq: snap.seq, blob: b64(snap.blob) };
      from = Math.max(since, snap.seq);
    }
  }
  out.updates = repo.getUpdatesSince(vaultId, from).map((u) => ({ seq: u.seq, blob: b64(u.blob) }));
  return out;
}

function jsonBodyLimit(maxBlobBytes: number, count = 1): string {
  return String(Math.ceil((maxBlobBytes * 4) / 3) * count + 4096);
}

function noStore(_req: Request, res: Response, next: () => void): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function vaultsRouter({ config, repo, rooms, limiters }: VaultDeps): Router {
  const r = Router();
  r.use(noStore);
  const auth = requireVault(repo);

  // ---- create -------------------------------------------------------------
  r.post('/vaults', limiters.createVault, express.json({ limit: '4kb' }), (req, res) => {
    const secret = req.header('x-notepad-create-secret') ?? '';
    if (config.createSecret !== null && !secretsEqual(secret, config.createSecret)) {
      res.status(401).json({ error: 'bad_secret' });
      return;
    }
    const { vaultId, token } = (req.body ?? {}) as Record<string, unknown>;
    if (!isVaultId(vaultId) || !isAuthToken(token)) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    if (!repo.createVault(vaultId, hashToken(token))) {
      res.status(409).json({ error: 'exists' });
      return;
    }
    res.status(201).json({ vaultId });
  });

  // ---- initial catch-up ---------------------------------------------------
  r.get('/vaults/:id/state', auth, (req, res) => {
    const since = Number(req.query['since'] ?? 0);
    if (!isSeq(since)) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const { vault } = res.locals as VaultLocals;
    res.json(buildState(repo, vault.id, since));
  });

  // ---- push updates -------------------------------------------------------
  r.post(
    '/vaults/:id/updates',
    express.json({ limit: jsonBodyLimit(config.maxUpdateBytes, LIMITS.maxUpdatesPerBatch) }),
    auth,
    (req, res) => {
      const { vault } = res.locals as VaultLocals;
      const body = req.body as { updates?: unknown };
      const list = body?.updates;
      if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.maxUpdatesPerBatch) {
        res.status(400).json({ error: 'bad_request' });
        return;
      }
      const items: { id: string; blob: Buffer }[] = [];
      for (const it of list as unknown[]) {
        const o = it as Record<string, unknown>;
        if (typeof o?.['id'] !== 'string' || o['id'].length > 64 || !isUpdateBlob(o['blob'])) {
          res.status(400).json({ error: 'bad_request' });
          return;
        }
        const blob = fromB64(o['blob']);
        if (blob.byteLength > config.maxUpdateBytes) {
          res.status(413).json({ error: 'too_large' });
          return;
        }
        items.push({ id: o['id'], blob });
      }
      const out: PostUpdatesResponse = { acks: [], head: 0, updatesSinceSnapshot: 0 };
      for (const it of items) {
        let seq: number;
        try {
          seq = repo.appendUpdate(vault.id, it.blob, config.vaultQuotaBytes);
        } catch (e) {
          if (e instanceof QuotaError) {
            res.status(413).json({ error: 'quota', acks: out.acks });
            return;
          }
          throw e;
        }
        out.acks.push({ id: it.id, seq });
        rooms.broadcastUpdate(vault.id, seq, b64(it.blob));
      }
      const st = repo.getState(vault.id);
      out.head = st.head;
      out.updatesSinceSnapshot = st.updatesSinceSnapshot;
      res.json(out);
    },
  );

  // ---- long-poll ----------------------------------------------------------
  r.get('/vaults/:id/events', auth, async (req, res) => {
    const { vault } = res.locals as VaultLocals;
    const since = Number(req.query['since'] ?? 0);
    const awSince = Number(req.query['awSince'] ?? 0);
    const wait = Math.min(Number(req.query['wait'] ?? config.longPollMaxWaitMs), config.longPollMaxWaitMs);
    if (!isSeq(since) || !isSeq(awSince) || !Number.isFinite(wait) || wait < 0) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }

    const respond = (): boolean => {
      const st = repo.getState(vault.id);
      if (since > st.head || since + 1 < st.oldestSeq) {
        res.status(409).json({ error: 'resync', head: st.head, oldestSeq: st.oldestSeq });
        return true;
      }
      const updates = repo.getUpdatesSince(vault.id, since).map((u) => ({ seq: u.seq, blob: b64(u.blob) }));
      const aw = rooms.awarenessSince(vault.id, awSince);
      if (updates.length > 0 || aw.blobs.length > 0) {
        const body: EventsResponse = {
          head: st.head,
          updatesSinceSnapshot: st.updatesSinceSnapshot,
          updates,
          awareness: aw.blobs,
          awTick: aw.tick,
        };
        res.json(body);
        return true;
      }
      return false;
    };

    if (respond()) return;
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    await rooms.wait(vault.id, since, awSince, wait, ac.signal);
    if (ac.signal.aborted || res.writableEnded) return;
    if (respond()) return;
    const st = repo.getState(vault.id);
    const aw = rooms.awarenessSince(vault.id, awSince);
    const body: EventsResponse = {
      head: st.head,
      updatesSinceSnapshot: st.updatesSinceSnapshot,
      updates: [],
      awareness: [],
      awTick: aw.tick,
    };
    res.json(body);
  });

  // ---- awareness (also used via sendBeacon with the token in the body) ----
  r.post('/vaults/:id/awareness', express.json({ limit: jsonBodyLimit(config.maxAwarenessBytes) }), auth, (req, res) => {
    const { vault } = res.locals as VaultLocals;
    const blob = (req.body as Record<string, unknown>)?.['blob'];
    if (!isAwarenessBlob(blob) || fromB64(blob).byteLength > config.maxAwarenessBytes) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    rooms.publishAwareness(vault.id, blob);
    res.status(204).end();
  });

  // ---- snapshot / compaction ---------------------------------------------
  r.post('/vaults/:id/snapshot', express.json({ limit: jsonBodyLimit(config.maxSnapshotBytes) }), auth, (req, res) => {
    const { vault } = res.locals as VaultLocals;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const blob = body['blob'];
    const baseSeq = body['baseSeq'];
    if (!isSnapshotBlob(blob) || !isSeq(baseSeq) || baseSeq === 0) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const bytes = fromB64(blob);
    if (bytes.byteLength > config.maxSnapshotBytes) {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    if (!repo.storeSnapshot(vault.id, bytes, baseSeq)) {
      res.status(409).json({ error: 'conflict', ...repo.getState(vault.id) });
      return;
    }
    res.json({ snapshotSeq: baseSeq });
  });

  return r;
}
