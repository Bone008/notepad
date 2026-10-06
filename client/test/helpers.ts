import { deriveVaultKeys, generateVaultId, generateVaultKey, toBase64Url } from '@notepad/shared';
import { createApp, type App } from '../../server/src/app.js';
import type { Config } from '../../server/src/config.js';
import { VaultSession, type SessionOptions } from '../src/core/session.js';
import type { CloseReason, Transport, TransportConfig, TransportEvents } from '../src/core/transport.js';

export const CREATE_SECRET = 'client-test-secret';

export interface TestServer {
  app: App;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const config: Config = {
    port: 0,
    dataDir: '.',
    dbPath: ':memory:',
    createSecret: CREATE_SECRET,
    allowInsecureCreate: false,
    trustProxy: false,
    maxUpdateBytes: 1024 * 1024,
    maxAwarenessBytes: 16 * 1024,
    maxSnapshotBytes: 16 * 1024 * 1024,
    vaultQuotaBytes: 64 * 1024 * 1024,
    longPollMaxWaitMs: 2000,
    pairTtlSec: 600,
    staticDir: null,
    logLevel: 'silent',
    rateLimits: false,
    ...overrides,
  };
  const app = createApp(config);
  const port = await new Promise<number>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const a = app.server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    });
  });
  return { app, port, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export interface TestVault {
  vaultId: string;
  keyB64: string;
}

export async function createVault(server: TestServer): Promise<TestVault> {
  const vaultId = generateVaultId();
  const key = generateVaultKey();
  const keys = await deriveVaultKeys(vaultId, key);
  const res = await fetch(`${server.baseUrl}/api/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notepad-Create-Secret': CREATE_SECRET },
    body: JSON.stringify({ vaultId, token: keys.authToken }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return { vaultId, keyB64: toBase64Url(key) };
}

let nsCounter = 0;
export function openSession(
  server: TestServer | { baseUrl: string },
  vault: TestVault,
  opts: Partial<SessionOptions> & { ns?: string } = {},
): VaultSession {
  const { ns, ...rest } = opts;
  return new VaultSession({
    vaultId: vault.vaultId,
    keyB64: vault.keyB64,
    baseUrl: server.baseUrl,
    forceHttp: () => false,
    user: () => ({ name: 'tester', color: '#123456' }),
    storageNamespace: ns ?? `dev${nsCounter++}-`,
    flushDelayMs: 10,
    ...rest,
  });
}

export async function waitFor(pred: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A transport that fails immediately, simulating a blocked WebSocket. */
export class FailingTransport implements Transport {
  readonly kind = 'ws' as const;
  static attempts = 0;
  constructor(
    _cfg: TransportConfig,
    private readonly reason: CloseReason = 'network',
  ) {}
  connect(ev: TransportEvents): void {
    FailingTransport.attempts++;
    setTimeout(() => ev.onClose(this.reason), 5);
  }
  send(): void {}
  close(): void {}
}
