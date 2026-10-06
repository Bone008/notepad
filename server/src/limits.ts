import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

export interface Limiters {
  api: RequestHandler;
  createVault: RequestHandler;
  pairPost: RequestHandler;
  pairClaim: RequestHandler;
  pairStatus: RequestHandler;
}

const passthrough: RequestHandler = (_req, _res, next) => next();

export function createLimiters(enabled: boolean): Limiters {
  if (!enabled) {
    return { api: passthrough, createVault: passthrough, pairPost: passthrough, pairClaim: passthrough, pairStatus: passthrough };
  }
  const mk = (limit: number): RequestHandler =>
    rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false });
  return {
    api: mk(600),
    createVault: mk(10),
    pairPost: mk(20),
    pairClaim: mk(10),
    pairStatus: mk(60),
  };
}
