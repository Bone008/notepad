import * as Y from 'yjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalDocPersistence, resealDocDb } from '../src/core/localDoc.js';
import { disableLock, enableLock, isLocked, lockTab, openBytes, openString, sealBytes, sealString, unlock } from '../src/core/localLock.js';
import { SyncStore } from '../src/core/syncStore.js';

class MemoryStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

const PASSWORD = 'correct horse battery';

function rawValues(dbName: string, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
      get.onerror = () => reject(get.error);
    };
  });
}

function containsText(values: unknown[], text: string): boolean {
  const needle = Buffer.from(text);
  return values.some((v) => v instanceof Uint8Array && Buffer.from(v).includes(needle));
}

async function writeDoc(name: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  const p = new LocalDocPersistence(name, doc);
  await p.whenSynced;
  doc.getText('t').insert(doc.getText('t').length, text);
  await p.destroy();
  doc.destroy();
}

async function readDoc(name: string): Promise<string> {
  const doc = new Y.Doc();
  const p = new LocalDocPersistence(name, doc);
  await p.whenSynced;
  const s = doc.getText('t').toString();
  await p.destroy();
  doc.destroy();
  return s;
}

beforeAll(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('sessionStorage', new MemoryStorage());
});

describe('local access control', () => {
  it('passes values through unchanged while off, and encrypts everything after turning it on', async () => {
    await writeDoc('notepad-doc-lt1', 'plain secret');
    const sync = new SyncStore('notepad-sync-lt1');
    await sync.setLastSeq(7);
    await sync.setOutbox([new TextEncoder().encode('outbox secret')]);
    expect(containsText(await rawValues('notepad-doc-lt1', 'updates'), 'plain secret')).toBe(true);
    expect(await sealString('x', 'hello')).toBe('hello');

    await enableLock(PASSWORD, async () => {
      await resealDocDb('notepad-doc-lt1');
      await sync.reseal();
    });
    expect(isLocked()).toBe(false);
    // Only the wrapped key is stored; the data key itself stays in memory.
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('notepad:lock')).not.toBeNull();

    const docValues = await rawValues('notepad-doc-lt1', 'updates');
    expect(docValues).toHaveLength(1);
    expect(containsText(docValues, 'plain secret')).toBe(false);
    const kv = await rawValues('notepad-sync-lt1', 'kv');
    expect(kv.every((v) => typeof v !== 'number')).toBe(true);
    expect(JSON.stringify(kv)).not.toContain('outbox secret');

    expect(await readDoc('notepad-doc-lt1')).toBe('plain secret');
    const st = await sync.load();
    expect(st.lastSeq).toBe(7);
    expect(new TextDecoder().decode(st.outbox[0])).toBe('outbox secret');

    // New writes are sealed too.
    await writeDoc('notepad-doc-lt1', ' more');
    expect(containsText(await rawValues('notepad-doc-lt1', 'updates'), ' more')).toBe(false);
    expect(await readDoc('notepad-doc-lt1')).toBe('plain secret more');

    const s = await sealString('state|notepad', '{"state":{"x":"vault key"}}');
    expect(s).not.toContain('vault key');
    expect(await openString('state|notepad', s)).toBe('{"state":{"x":"vault key"}}');
  });

  it('binds sealed values to their slot', async () => {
    const sealed = await sealBytes('a', new Uint8Array([1, 2, 3]));
    await expect(openBytes('b', sealed)).rejects.toThrow();
    expect([...(await openBytes('a', sealed))]).toEqual([1, 2, 3]);
  });

  it('forgets the key on logout and needs the right password to unlock', async () => {
    lockTab();
    expect(isLocked()).toBe(true);
    await expect(readDoc('notepad-doc-lt1')).rejects.toThrow(/locked/);
    await expect(sealBytes('a', new Uint8Array([1]))).rejects.toThrow(/locked/);

    expect(await unlock('wrong password')).toBe(false);
    expect(isLocked()).toBe(true);
    expect(await unlock(PASSWORD)).toBe(true);
    expect(await readDoc('notepad-doc-lt1')).toBe('plain secret more');
  });

  it('turns off again, leaving plaintext that loads without a key', async () => {
    expect(await disableLock('wrong password', async () => undefined)).toBe(false);
    expect(await disableLock(PASSWORD, () => resealDocDb('notepad-doc-lt1'))).toBe(true);
    expect(localStorage.getItem('notepad:lock')).toBeNull();
    expect(isLocked()).toBe(false);
    expect(containsText(await rawValues('notepad-doc-lt1', 'updates'), 'plain secret')).toBe(true);
    expect(await readDoc('notepad-doc-lt1')).toBe('plain secret more');
  });
});
