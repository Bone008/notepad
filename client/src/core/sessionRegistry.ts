import { VaultSession, type SessionOptions } from './session.js';

interface Entry {
  session: VaultSession;
  refs: number;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();
const DROP_DELAY_MS = 2000;

/**
 * Ref-counted sessions so React StrictMode's mount/unmount/mount and quick navigations
 * don't tear down and rebuild the connection.
 */
export function acquireSession(opts: SessionOptions): VaultSession {
  let e = entries.get(opts.vaultId);
  if (!e) {
    e = { session: new VaultSession(opts), refs: 0, dropTimer: null };
    entries.set(opts.vaultId, e);
  }
  if (e.dropTimer) {
    clearTimeout(e.dropTimer);
    e.dropTimer = null;
  }
  e.refs += 1;
  return e.session;
}

export function releaseSession(vaultId: string): void {
  const e = entries.get(vaultId);
  if (!e) return;
  e.refs -= 1;
  if (e.refs > 0) return;
  e.dropTimer = setTimeout(() => {
    if (e.refs === 0) {
      entries.delete(vaultId);
      e.session.destroy();
    }
  }, DROP_DELAY_MS);
}

export function peekSession(vaultId: string): VaultSession | null {
  return entries.get(vaultId)?.session ?? null;
}

/** Destroy immediately regardless of refs (used by "leave vault"). */
export async function evictSession(vaultId: string): Promise<VaultSession | null> {
  const e = entries.get(vaultId);
  if (!e) return null;
  if (e.dropTimer) clearTimeout(e.dropTimer);
  entries.delete(vaultId);
  return e.session;
}
