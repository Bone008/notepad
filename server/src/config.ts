import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@notepad/shared';

export interface Config {
  port: number;
  dataDir: string;
  /** SQLite file path or ":memory:" */
  dbPath: string;
  createSecret: string | null;
  allowInsecureCreate: boolean;
  trustProxy: boolean | number | string;
  maxUpdateBytes: number;
  maxAwarenessBytes: number;
  maxSnapshotBytes: number;
  vaultQuotaBytes: number;
  longPollMaxWaitMs: number;
  pairTtlSec: number;
  /** Directory with the built client, or null to serve no static files. */
  staticDir: string | null;
  logLevel: 'silent' | 'info';
  /** Disable only for tests. */
  rateLimits: boolean;
}

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid numeric config value: ${v}`);
  return n;
}

function bool(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

export function defaultStaticDir(): string {
  // server/src/config.ts (dev) and server/dist/index.js (prod) are both two levels below the repo root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env['NOTEPAD_DATA_DIR'] || './.data';
  const createSecret = env['NOTEPAD_CREATE_SECRET'] || null;
  const allowInsecureCreate = bool(env['NOTEPAD_ALLOW_INSECURE_CREATE']);
  if (!createSecret && !allowInsecureCreate) {
    throw new Error('NOTEPAD_CREATE_SECRET is required (or set NOTEPAD_ALLOW_INSECURE_CREATE=1 for local development)');
  }
  const trustRaw = env['NOTEPAD_TRUST_PROXY'];
  let trustProxy: Config['trustProxy'] = false;
  if (trustRaw) trustProxy = /^\d+$/.test(trustRaw) ? Number(trustRaw) : bool(trustRaw) ? true : trustRaw;
  return {
    port: num(env['PORT'], 3000),
    dataDir,
    dbPath: env['NOTEPAD_DB'] || path.join(dataDir, 'notepad.sqlite'),
    createSecret,
    allowInsecureCreate,
    trustProxy,
    maxUpdateBytes: num(env['NOTEPAD_MAX_UPDATE_BYTES'], LIMITS.maxUpdateBytes),
    maxAwarenessBytes: num(env['NOTEPAD_MAX_AWARENESS_BYTES'], LIMITS.maxAwarenessBytes),
    maxSnapshotBytes: num(env['NOTEPAD_MAX_SNAPSHOT_BYTES'], LIMITS.maxSnapshotBytes),
    vaultQuotaBytes: num(env['NOTEPAD_VAULT_QUOTA_BYTES'], 256 * 1024 * 1024),
    longPollMaxWaitMs: num(env['NOTEPAD_LONGPOLL_MAX_WAIT_MS'], LIMITS.longPollMaxWaitMs),
    pairTtlSec: num(env['NOTEPAD_PAIR_TTL_SEC'], LIMITS.pairTtlSec),
    staticDir: env['NOTEPAD_STATIC_DIR'] === '' ? null : env['NOTEPAD_STATIC_DIR'] || defaultStaticDir(),
    logLevel: env['NODE_ENV'] === 'test' ? 'silent' : 'info',
    rateLimits: env['NOTEPAD_RATE_LIMITS'] !== '0',
  };
}
