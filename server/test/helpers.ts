import { generateVaultId, randomBytes, toBase64Url } from '@notepad/shared';
import { createApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';

export const TEST_SECRET = 'test-secret';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    dataDir: '.',
    dbPath: ':memory:',
    createSecret: TEST_SECRET,
    allowInsecureCreate: false,
    trustProxy: false,
    maxUpdateBytes: 2048,
    maxAwarenessBytes: 1024,
    maxSnapshotBytes: 1024 * 1024,
    vaultQuotaBytes: 1024 * 1024,
    longPollMaxWaitMs: 2000,
    pairTtlSec: 600,
    staticDir: null,
    logLevel: 'silent',
    rateLimits: false,
    ...overrides,
  };
}

export function makeApp(overrides: Partial<Config> = {}): App {
  return createApp(testConfig(overrides));
}

export interface TestVault {
  id: string;
  token: string;
}

export function newVaultCreds(): TestVault {
  return { id: generateVaultId(), token: toBase64Url(randomBytes(32)) };
}

export function blob(bytes: number, fill = 7): string {
  const b = new Uint8Array(bytes).fill(fill);
  return toBase64Url(b);
}

export function listen(app: App): Promise<number> {
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const addr = app.server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}
