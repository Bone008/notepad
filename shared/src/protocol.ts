import { isBase64Url } from './base64url.js';
import { VAULT_ID_BYTES } from './crypto.js';

export const LIMITS = {
  maxUpdateBytes: 1024 * 1024,
  maxAwarenessBytes: 16 * 1024,
  maxSnapshotBytes: 64 * 1024 * 1024,
  maxUpdatesPerBatch: 20,
  longPollMaxWaitMs: 25_000,
  wsAuthTimeoutMs: 5_000,
  pairTtlSec: 600,
  /** Server suggests compaction once this many updates sit above the latest snapshot. */
  snapshotAfterUpdates: 200,
} as const;

export const WS_PATH = '/ws';

export interface UpdateRecord {
  seq: number;
  /** base64url encrypted frame */
  blob: string;
}

export type ClientMessage =
  | { t: 'auth'; vaultId: string; token: string; since: number }
  | { t: 'update'; id: string; blob: string }
  | { t: 'awareness'; blob: string }
  | { t: 'snapshot'; blob: string; baseSeq: number }
  | { t: 'ping' };

export type ServerErrorCode = 'unauthorized' | 'too_large' | 'quota' | 'bad_request' | 'resync' | 'conflict';

export type ServerMessage =
  | { t: 'ready'; head: number; snapshotSeq: number; oldestSeq: number; updatesSinceSnapshot: number }
  | { t: 'snapshot'; seq: number; blob: string }
  | { t: 'update'; seq: number; blob: string }
  | { t: 'awareness'; blob: string }
  | { t: 'ack'; id: string; seq: number; head: number; updatesSinceSnapshot: number }
  | { t: 'snapshot_ack'; snapshotSeq: number }
  | { t: 'error'; code: ServerErrorCode; message?: string }
  | { t: 'pong' };

export interface StateResponse {
  head: number;
  snapshotSeq: number;
  oldestSeq: number;
  updatesSinceSnapshot: number;
  snapshot?: { seq: number; blob: string };
  updates: UpdateRecord[];
}

export interface EventsResponse {
  head: number;
  updatesSinceSnapshot: number;
  updates: UpdateRecord[];
  awareness: string[];
  awTick: number;
}

export interface PostUpdatesResponse {
  acks: { id: string; seq: number }[];
  head: number;
  updatesSinceSnapshot: number;
}

export function isVaultId(s: unknown): s is string {
  return typeof s === 'string' && isBase64Url(s, VAULT_ID_BYTES);
}

export function isAuthToken(s: unknown): s is string {
  return typeof s === 'string' && isBase64Url(s, 32);
}

function isSeq(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function isBlob(b: unknown, maxBytes: number): b is string {
  // base64url expands bytes by 4/3; bound the string length accordingly.
  return typeof b === 'string' && b.length > 0 && b.length <= Math.ceil((maxBytes * 4) / 3) + 4 && isBase64Url(b);
}

/** Validate an inbound WebSocket message. Returns null for anything malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m['t']) {
    case 'auth':
      return isVaultId(m['vaultId']) && isAuthToken(m['token']) && isSeq(m['since'])
        ? { t: 'auth', vaultId: m['vaultId'], token: m['token'], since: m['since'] }
        : null;
    case 'update':
      return typeof m['id'] === 'string' && m['id'].length <= 64 && isBlob(m['blob'], LIMITS.maxUpdateBytes)
        ? { t: 'update', id: m['id'], blob: m['blob'] }
        : null;
    case 'awareness':
      return isBlob(m['blob'], LIMITS.maxAwarenessBytes) ? { t: 'awareness', blob: m['blob'] } : null;
    case 'snapshot':
      return isBlob(m['blob'], LIMITS.maxSnapshotBytes) && isSeq(m['baseSeq'])
        ? { t: 'snapshot', blob: m['blob'], baseSeq: m['baseSeq'] }
        : null;
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}

export function isUpdateBlob(b: unknown): b is string {
  return isBlob(b, LIMITS.maxUpdateBytes);
}
export function isAwarenessBlob(b: unknown): b is string {
  return isBlob(b, LIMITS.maxAwarenessBytes);
}
export function isSnapshotBlob(b: unknown): b is string {
  return isBlob(b, LIMITS.maxSnapshotBytes);
}
export { isSeq };
