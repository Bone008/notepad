import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFile, getFileText, initVault, listFiles } from '../src/core/files.js';
import { LocalDocPersistence } from '../src/core/localDoc.js';
import { docDbName } from '../src/core/syncStore.js';
import { FailingTransport, createVault, openSession, sleep, startServer, waitFor, type TestServer } from './helpers.js';

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
});

function text(doc: Y.Doc): string {
  const f = listFiles(doc)[0];
  return f ? (getFileText(doc, f.id)?.toString() ?? '') : '';
}

describe.each([
  { label: 'websocket', forceHttp: false, expectedTransport: 'ws' as const },
  { label: 'http long-poll', forceHttp: true, expectedTransport: 'http' as const },
])('live collaboration over $label', ({ forceHttp, expectedTransport }) => {
  it('converges between two devices and reports synced', async () => {
    const vault = await createVault(server);
    const a = openSession(server, vault, { forceHttp: () => forceHttp });
    await a.ready;
    const fileId = initVault(a.doc, 'Team');
    await waitFor(() => a.status.get().state === 'synced', 5000, 'A synced');
    expect(a.status.get().transport).toBe(expectedTransport);
    expect(a.status.get().pending).toBe(0);

    const b = openSession(server, vault, { forceHttp: () => forceHttp });
    await b.ready;
    await waitFor(() => text(b.doc) === text(a.doc) && text(b.doc).length > 0, 5000, 'B receives A content');
    expect(listFiles(b.doc)[0]?.id).toBe(fileId);

    getFileText(b.doc, fileId)!.insert(getFileText(b.doc, fileId)!.length, 'hello from B');
    await waitFor(() => text(a.doc).endsWith('hello from B'), 5000, 'A receives B edit');

    getFileText(a.doc, fileId)!.insert(0, 'A first: ');
    await waitFor(() => text(b.doc).startsWith('A first: '), 5000, 'B receives A edit');

    await waitFor(() => a.status.get().peers === 2 && b.status.get().peers === 2, 5000, 'presence count');
    await waitFor(() => a.status.get().state === 'synced' && b.status.get().state === 'synced', 5000, 'both synced');

    // Server only ever saw ciphertext: no plaintext in the log.
    const st = server.app.repo.getState(vault.vaultId);
    expect(st.head).toBeGreaterThan(0);
    for (const u of server.app.repo.getUpdatesSince(vault.vaultId, 0)) {
      expect(Buffer.from(u.blob).includes(Buffer.from('hello from B'))).toBe(false);
    }
    a.destroy();
    b.destroy();
  });
});

describe('offline and recovery', () => {
  it('queues edits while unreachable and pushes them after reconnecting on a new session', async () => {
    const vault = await createVault(server);
    const dead = { baseUrl: 'http://127.0.0.1:1' };
    const offline = openSession(dead, vault, { ns: 'offline-', forceHttp: () => true });
    await offline.ready;
    initVault(offline.doc, 'Offline vault');
    await sleep(100);
    expect(offline.status.get().pending).toBeGreaterThan(0);
    expect(offline.status.get().state).not.toBe('synced');
    offline.destroy();

    // "Network is back, app reopened": same local storage, reachable server.
    const back = openSession(server, vault, { ns: 'offline-' });
    await back.ready;
    await waitFor(() => back.status.get().state === 'synced' && back.status.get().pending === 0, 5000, 'pushed');
    expect(server.app.repo.getState(vault.vaultId).head).toBeGreaterThan(0);

    const other = openSession(server, vault);
    await other.ready;
    await waitFor(() => text(other.doc) === text(back.doc) && text(other.doc).length > 0, 5000, 'other converged');
    back.destroy();
    other.destroy();
  });

  it('pushes edits that were persisted locally but missing from the outbox (safety net)', async () => {
    const vault = await createVault(server);
    const a = openSession(server, vault, { ns: 'safety-' });
    await a.ready;
    const fileId = initVault(a.doc, 'Safety');
    await waitFor(() => a.status.get().state === 'synced', 5000, 'A synced');
    a.destroy();

    // Edit the local doc through the local persistence alone, bypassing the provider's outbox entirely.
    const doc = new Y.Doc();
    const idb = new LocalDocPersistence(docDbName('safety-', vault.vaultId), doc);
    await idb.whenSynced;
    (doc.getMap('files').get(fileId) as Y.Map<unknown>).get('text');
    getFileText(doc, fileId)!.insert(0, 'ghost edit ');
    await idb.destroy();
    doc.destroy();

    const a2 = openSession(server, vault, { ns: 'safety-' });
    await a2.ready;
    await waitFor(() => a2.status.get().state === 'synced' && a2.status.get().pending === 0, 5000, 'A2 synced');
    const b = openSession(server, vault);
    await b.ready;
    await waitFor(() => text(b.doc).startsWith('ghost edit '), 5000, 'ghost edit reached B');
    a2.destroy();
    b.destroy();
  });

  it('re-uploads everything when the server has lost the vault log', async () => {
    const vault = await createVault(server);
    const a = openSession(server, vault, { ns: 'reset-' });
    await a.ready;
    initVault(a.doc, 'Reset');
    await waitFor(() => a.status.get().state === 'synced', 5000, 'A synced');
    a.destroy();

    // Simulate a fresh server that only knows the vault id/token.
    const fresh = await startServer();
    try {
      const keysRes = await fetch(`${fresh.baseUrl}/api/vaults`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Notepad-Create-Secret': 'client-test-secret' },
        body: JSON.stringify({ vaultId: vault.vaultId, token: a.keys.authToken }),
      });
      expect(keysRes.status).toBe(201);
      const a2 = openSession(fresh, vault, { ns: 'reset-' });
      await a2.ready;
      await waitFor(() => a2.status.get().state === 'synced' && a2.status.get().pending === 0, 5000, 'A2 synced');
      expect(fresh.app.repo.getState(vault.vaultId).head).toBeGreaterThan(0);
      const b = openSession(fresh, vault);
      await b.ready;
      await waitFor(() => text(b.doc) === text(a2.doc) && text(b.doc).length > 0, 5000, 'B converged');
      a2.destroy();
      b.destroy();
    } finally {
      await fresh.close();
    }
  });
});

describe('snapshots', () => {
  it('compacts the server log and lets a new device bootstrap from the snapshot', async () => {
    const vault = await createVault(server);
    const a = openSession(server, vault, { snapshotAfterUpdates: 3, snapshotDelayMs: [10, 20] });
    await a.ready;
    const fileId = initVault(a.doc, 'Snap');
    await waitFor(() => a.status.get().state === 'synced', 5000, 'A synced');
    for (let i = 0; i < 5; i++) {
      getFileText(a.doc, fileId)!.insert(0, `${i}`);
      await waitFor(() => a.status.get().pending === 0 && a.status.get().state === 'synced', 5000, `edit ${i} synced`);
    }
    await waitFor(() => server.app.repo.getState(vault.vaultId).snapshotSeq > 0, 5000, 'server snapshot');
    const st = server.app.repo.getState(vault.vaultId);
    expect(st.oldestSeq).toBe(st.snapshotSeq + 1);

    const b = openSession(server, vault);
    await b.ready;
    await waitFor(() => text(b.doc) === text(a.doc) && text(b.doc).length > 0, 5000, 'B via snapshot');
    createFile(b.doc, 'Second.md', 'two');
    await waitFor(() => listFiles(a.doc).length === 2, 5000, 'A sees new file');
    a.destroy();
    b.destroy();
  });
});

describe('presence', () => {
  it('does not duplicate a device that refreshed without saying goodbye', async () => {
    const vault = await createVault(server);
    const identity = { sessionId: 'tab-1', deviceId: 'dev-1' };
    const a1 = openSession(server, vault, { ns: 'refresh-', identity });
    await a1.ready;
    initVault(a1.doc, 'Presence');
    const b = openSession(server, vault);
    await b.ready;
    await waitFor(() => b.status.get().peers === 2, 5000, 'B sees A1');

    // Hard refresh: the tab dies without a leave message, the new page gets a new Yjs client id.
    a1.destroy();
    const a2 = openSession(server, vault, { ns: 'refresh-', identity });
    await a2.ready;
    await waitFor(() => a2.status.get().state === 'synced', 5000, 'A2 synced');
    expect(a2.doc.clientID).not.toBe(a1.doc.clientID);

    // Everyone settles on exactly two devices well before the 30 s awareness timeout.
    await waitFor(() => a2.status.get().peers === 2 && b.status.get().peers === 2, 5000, 'no duplicates');
    await sleep(300);
    expect(a2.status.get().peers).toBe(2);
    expect(b.status.get().peers).toBe(2);
    expect([...b.awareness.getStates().keys()]).not.toContain(a1.doc.clientID);
    a2.destroy();
    b.destroy();
  });
});

describe('transport selection', () => {
  it('falls back to HTTP when the WebSocket cannot connect', async () => {
    const vault = await createVault(server);
    FailingTransport.attempts = 0;
    const a = openSession(server, vault, { transports: { ws: (cfg) => new FailingTransport(cfg) } });
    await a.ready;
    initVault(a.doc, 'Fallback');
    await waitFor(() => a.status.get().state === 'synced', 5000, 'synced over http');
    expect(a.status.get().transport).toBe('http');
    expect(FailingTransport.attempts).toBe(1);
    a.destroy();
  });

  it('reports unauthorized when the vault does not exist on the server', async () => {
    const vault = await createVault(server);
    const a = openSession(server, { vaultId: vault.vaultId, keyB64: (await createVault(server)).keyB64 });
    await a.ready;
    await waitFor(() => a.status.get().state === 'unauthorized', 5000, 'unauthorized');
    a.destroy();
  });

  it('skips WebSocket entirely when HTTP mode is forced', async () => {
    const vault = await createVault(server);
    FailingTransport.attempts = 0;
    const a = openSession(server, vault, { forceHttp: () => true, transports: { ws: (cfg) => new FailingTransport(cfg) } });
    await a.ready;
    await waitFor(() => a.status.get().state === 'synced', 5000, 'synced');
    expect(FailingTransport.attempts).toBe(0);
    expect(a.status.get().transport).toBe('http');
    a.destroy();
  });
});
