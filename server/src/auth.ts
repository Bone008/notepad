import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { isAuthToken, isVaultId } from '@notepad/shared';
import type { Repo, VaultRow } from './db.js';

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function secretsEqual(a: string, b: string): boolean {
  // Hash both sides so lengths never leak through timingSafeEqual's length check.
  return timingSafeEqual(hashToken(a), hashToken(b));
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
}

export function authorizeVault(repo: Repo, vaultId: unknown, token: unknown): VaultRow | null {
  if (!isVaultId(vaultId) || !isAuthToken(token)) return null;
  const vault = repo.getVault(vaultId);
  if (!vault) return null;
  const given = hashToken(token);
  if (given.length !== vault.token_hash.byteLength) return null;
  if (!timingSafeEqual(given, Buffer.from(vault.token_hash))) return null;
  return vault;
}

export interface VaultLocals {
  vault: VaultRow;
}

/** Express middleware: requires a valid Bearer token for `req.params.id`; sets res.locals.vault. */
export function requireVault(repo: Repo) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(req) ?? (typeof req.body?.token === 'string' ? req.body.token : null);
    const vault = authorizeVault(repo, req.params['id'], token);
    if (!vault) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    (res.locals as VaultLocals).vault = vault;
    next();
  };
}
