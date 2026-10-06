import express, { Router } from 'express';
import { isBase64Url, PAIR_LOOKUP_BYTES } from '@notepad/shared';
import type { Config } from '../config.js';
import type { Repo } from '../db.js';
import type { Limiters } from '../limits.js';

/** Wrapped vault key is a small JSON frame; 4 KiB leaves plenty of room. */
export const MAX_PAIR_BLOB_BYTES = 4096;

function isLookupId(s: unknown): s is string {
  return typeof s === 'string' && isBase64Url(s, PAIR_LOOKUP_BYTES);
}

export function pairRouter(config: Config, repo: Repo, limiters: Limiters): Router {
  const r = Router();
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  r.post('/pair', limiters.pairPost, express.json({ limit: '8kb' }), (req, res) => {
    const { lookupId, blob } = (req.body ?? {}) as Record<string, unknown>;
    if (!isLookupId(lookupId) || typeof blob !== 'string' || !isBase64Url(blob)) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const bytes = Buffer.from(blob, 'base64url');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PAIR_BLOB_BYTES) {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    const expiresAt = Date.now() + config.pairTtlSec * 1000;
    if (!repo.putPairing(lookupId, bytes, expiresAt)) {
      res.status(409).json({ error: 'exists' });
      return;
    }
    res.status(201).json({ expiresAt });
  });

  // One-shot claim. Unknown, expired and already-claimed all look identical.
  r.get('/pair/:lookupId', limiters.pairClaim, (req, res) => {
    const id = req.params['lookupId'];
    if (!isLookupId(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const blob = repo.claimPairing(id);
    if (!blob) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ blob: Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).toString('base64url') });
  });

  // Polled by the device that displays the code.
  r.get('/pair/:lookupId/claimed', limiters.pairStatus, (req, res) => {
    const id = req.params['lookupId'];
    const status = isLookupId(id) ? repo.pairingStatus(id) : 'unknown';
    if (status === 'unknown') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ claimed: status === 'claimed' });
  });

  return r;
}
