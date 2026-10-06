import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url, randomBytes } from '@notepad/shared';
import type { App } from '../src/app.js';
import { TEST_SECRET, blob, makeApp, newVaultCreds, type TestVault } from './helpers.js';

let app: App;
beforeAll(() => {
  app = makeApp();
});
afterAll(async () => {
  await app.close();
});

async function createVault(v: TestVault = newVaultCreds()): Promise<TestVault> {
  await request(app.app)
    .post('/api/vaults')
    .set('x-notepad-create-secret', TEST_SECRET)
    .send({ vaultId: v.id, token: v.token })
    .expect(201);
  return v;
}

const auth = (v: TestVault): { Authorization: string } => ({ Authorization: `Bearer ${v.token}` });

describe('health', () => {
  it('responds', async () => {
    const res = await request(app.app).get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('vault creation', () => {
  it('requires the create secret', async () => {
    const v = newVaultCreds();
    await request(app.app).post('/api/vaults').send({ vaultId: v.id, token: v.token }).expect(401);
    await request(app.app)
      .post('/api/vaults')
      .set('x-notepad-create-secret', 'wrong')
      .send({ vaultId: v.id, token: v.token })
      .expect(401);
  });

  it('creates once and rejects duplicates and bad bodies', async () => {
    const v = await createVault();
    await request(app.app)
      .post('/api/vaults')
      .set('x-notepad-create-secret', TEST_SECRET)
      .send({ vaultId: v.id, token: v.token })
      .expect(409);
    await request(app.app)
      .post('/api/vaults')
      .set('x-notepad-create-secret', TEST_SECRET)
      .send({ vaultId: 'nope', token: v.token })
      .expect(400);
  });
});

describe('auth', () => {
  it('rejects wrong tokens and unknown vaults identically', async () => {
    const v = await createVault();
    const r1 = await request(app.app).get(`/api/vaults/${v.id}/state`).set('Authorization', `Bearer ${toBase64Url(randomBytes(32))}`);
    const r2 = await request(app.app).get(`/api/vaults/${newVaultCreds().id}/state`).set(auth(v));
    const r3 = await request(app.app).get(`/api/vaults/${v.id}/state`);
    expect([r1.status, r2.status, r3.status]).toEqual([401, 401, 401]);
    expect(r1.body).toEqual(r2.body);
  });
});

describe('updates and state', () => {
  it('assigns contiguous seqs and serves them since a cursor', async () => {
    const v = await createVault();
    const res = await request(app.app)
      .post(`/api/vaults/${v.id}/updates`)
      .set(auth(v))
      .send({ updates: [{ id: 'a', blob: blob(40, 1) }, { id: 'b', blob: blob(40, 2) }] })
      .expect(200);
    expect(res.body.acks).toEqual([
      { id: 'a', seq: 1 },
      { id: 'b', seq: 2 },
    ]);
    expect(res.body.head).toBe(2);
    expect(res.headers['cache-control']).toBe('no-store');

    const all = await request(app.app).get(`/api/vaults/${v.id}/state?since=0`).set(auth(v)).expect(200);
    expect(all.body.updates.map((u: { seq: number }) => u.seq)).toEqual([1, 2]);
    expect(all.body.updates[1].blob).toBe(blob(40, 2));
    expect(all.body.snapshot).toBeUndefined();
    expect(all.body.oldestSeq).toBe(1);

    const tail = await request(app.app).get(`/api/vaults/${v.id}/state?since=1`).set(auth(v)).expect(200);
    expect(tail.body.updates.map((u: { seq: number }) => u.seq)).toEqual([2]);
  });

  it('rejects malformed batches and oversize blobs', async () => {
    const v = await createVault();
    await request(app.app).post(`/api/vaults/${v.id}/updates`).set(auth(v)).send({ updates: [] }).expect(400);
    await request(app.app)
      .post(`/api/vaults/${v.id}/updates`)
      .set(auth(v))
      .send({ updates: [{ id: 'x', blob: 'not base64!' }] })
      .expect(400);
    await request(app.app)
      .post(`/api/vaults/${v.id}/updates`)
      .set(auth(v))
      .send({ updates: [{ id: 'x', blob: blob(3000) }] })
      .expect(413);
  });

  it('enforces the per-vault quota', async () => {
    const small = makeApp({ vaultQuotaBytes: 100 });
    try {
      const v = newVaultCreds();
      await request(small.app)
        .post('/api/vaults')
        .set('x-notepad-create-secret', TEST_SECRET)
        .send({ vaultId: v.id, token: v.token })
        .expect(201);
      await request(small.app)
        .post(`/api/vaults/${v.id}/updates`)
        .set(auth(v))
        .send({ updates: [{ id: 'a', blob: blob(60) }] })
        .expect(200);
      const r = await request(small.app)
        .post(`/api/vaults/${v.id}/updates`)
        .set(auth(v))
        .send({ updates: [{ id: 'b', blob: blob(60) }] })
        .expect(413);
      expect(r.body.error).toBe('quota');
    } finally {
      await small.close();
    }
  });
});

describe('long-poll events', () => {
  it('returns immediately when updates already exist', async () => {
    const v = await createVault();
    await request(app.app).post(`/api/vaults/${v.id}/updates`).set(auth(v)).send({ updates: [{ id: 'a', blob: blob(10) }] });
    const r = await request(app.app).get(`/api/vaults/${v.id}/events?since=0&wait=1000`).set(auth(v)).expect(200);
    expect(r.body.updates.map((u: { seq: number }) => u.seq)).toEqual([1]);
  });

  it('wakes on a new update and on awareness', async () => {
    const v = await createVault();
    const t0 = Date.now();
    const pending = request(app.app).get(`/api/vaults/${v.id}/events?since=0&wait=1500`).set(auth(v));
    setTimeout(() => {
      void request(app.app)
        .post(`/api/vaults/${v.id}/updates`)
        .set(auth(v))
        .send({ updates: [{ id: 'a', blob: blob(10) }] })
        .then(() => undefined);
    }, 100);
    const r = await pending.expect(200);
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(r.body.updates).toHaveLength(1);
    expect(r.body.head).toBe(1);

    const pending2 = request(app.app).get(`/api/vaults/${v.id}/events?since=1&awSince=0&wait=1500`).set(auth(v));
    setTimeout(() => {
      void request(app.app).post(`/api/vaults/${v.id}/awareness`).set(auth(v)).send({ blob: blob(20, 9) }).then((r) => expect(r.status).toBe(204));
    }, 100);
    const r2 = await pending2.expect(200);
    expect(r2.body.updates).toEqual([]);
    expect(r2.body.awareness).toEqual([blob(20, 9)]);
    expect(r2.body.awTick).toBe(1);
  });

  it('returns empty after the wait elapses', async () => {
    const v = await createVault();
    const t0 = Date.now();
    const r = await request(app.app).get(`/api/vaults/${v.id}/events?since=0&wait=150`).set(auth(v)).expect(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(r.body).toMatchObject({ head: 0, updates: [], awareness: [] });
  });

  it('accepts the token in the body for sendBeacon-style awareness posts', async () => {
    const v = await createVault();
    await request(app.app).post(`/api/vaults/${v.id}/awareness`).send({ token: v.token, blob: blob(8) }).expect(204);
    await request(app.app).post(`/api/vaults/${v.id}/awareness`).send({ blob: blob(8) }).expect(401);
  });
});

describe('snapshots and compaction', () => {
  it('replaces old updates with a snapshot and forces lagging clients to resync', async () => {
    const v = await createVault();
    await request(app.app)
      .post(`/api/vaults/${v.id}/updates`)
      .set(auth(v))
      .send({ updates: [{ id: 'a', blob: blob(10, 1) }, { id: 'b', blob: blob(10, 2) }, { id: 'c', blob: blob(10, 3) }] });

    // Cannot snapshot ahead of head.
    await request(app.app).post(`/api/vaults/${v.id}/snapshot`).set(auth(v)).send({ blob: blob(100), baseSeq: 9 }).expect(409);
    await request(app.app).post(`/api/vaults/${v.id}/snapshot`).set(auth(v)).send({ blob: blob(100), baseSeq: 2 }).expect(200);

    const st = await request(app.app).get(`/api/vaults/${v.id}/state?since=0`).set(auth(v)).expect(200);
    expect(st.body.snapshot).toEqual({ seq: 2, blob: blob(100) });
    expect(st.body.updates.map((u: { seq: number }) => u.seq)).toEqual([3]);
    expect(st.body.oldestSeq).toBe(3);
    expect(st.body.snapshotSeq).toBe(2);
    expect(st.body.updatesSinceSnapshot).toBe(1);

    // A client at seq 2 needs no snapshot.
    const st2 = await request(app.app).get(`/api/vaults/${v.id}/state?since=2`).set(auth(v)).expect(200);
    expect(st2.body.snapshot).toBeUndefined();
    expect(st2.body.updates).toHaveLength(1);

    // Lagging long-poller is told to resync.
    const ev = await request(app.app).get(`/api/vaults/${v.id}/events?since=0&wait=10`).set(auth(v)).expect(409);
    expect(ev.body.error).toBe('resync');
    // A client that is ahead of the server (e.g. server data was reset) is told to resync too.
    await request(app.app).get(`/api/vaults/${v.id}/events?since=50&wait=10`).set(auth(v)).expect(409);

    // Older snapshot is rejected.
    await request(app.app).post(`/api/vaults/${v.id}/snapshot`).set(auth(v)).send({ blob: blob(100), baseSeq: 2 }).expect(409);
    // Bytes accounting was recomputed.
    expect(app.repo.getVault(v.id)?.bytes_used).toBe(110);
  });
});

describe('pairing', () => {
  const lookup = (): string => toBase64Url(randomBytes(16));

  it('stores, reports claim status, and hands out the blob exactly once', async () => {
    const id = lookup();
    await request(app.app).post('/api/pair').send({ lookupId: id, blob: blob(200) }).expect(201);
    await request(app.app).post('/api/pair').send({ lookupId: id, blob: blob(200) }).expect(409);
    expect((await request(app.app).get(`/api/pair/${id}/claimed`).expect(200)).body).toEqual({ claimed: false });
    const r = await request(app.app).get(`/api/pair/${id}`).expect(200);
    expect(r.body.blob).toBe(blob(200));
    await request(app.app).get(`/api/pair/${id}`).expect(404);
    expect((await request(app.app).get(`/api/pair/${id}/claimed`).expect(200)).body).toEqual({ claimed: true });
    await request(app.app).get(`/api/pair/${lookup()}/claimed`).expect(404);
  });

  it('validates input', async () => {
    await request(app.app).post('/api/pair').send({ lookupId: 'short', blob: blob(10) }).expect(400);
    await request(app.app).post('/api/pair').send({ lookupId: lookup(), blob: blob(5000) }).expect(413);
    await request(app.app).get('/api/pair/not-a-valid-id').expect(404);
  });

  it('expires records', () => {
    const id = lookup();
    expect(app.repo.putPairing(id, new Uint8Array(4), Date.now() - 1)).toBe(true);
    expect(app.repo.claimPairing(id)).toBeNull();
    expect(app.repo.sweepPairings()).toBeGreaterThanOrEqual(1);
  });

  it('rate limits claims', async () => {
    const limited = makeApp({ rateLimits: true });
    try {
      let got429 = false;
      for (let i = 0; i < 12 && !got429; i++) {
        const r = await request(limited.app).get(`/api/pair/${lookup()}`);
        got429 = r.status === 429;
      }
      expect(got429).toBe(true);
    } finally {
      await limited.close();
    }
  });
});

describe('unknown api routes', () => {
  it('404 as json', async () => {
    const r = await request(app.app).get('/api/nope').expect(404);
    expect(r.body).toEqual({ error: 'not_found' });
  });
});
