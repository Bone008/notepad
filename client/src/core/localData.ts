import { resealDocDb } from './localDoc.js';
import { SyncStore, deleteDatabase, docDbName, syncDbName } from './syncStore.js';

const DOC_PREFIX = docDbName('', '');
const SYNC_PREFIX = syncDbName('', '');

/** Names of this app's IndexedDB databases: those of known vaults plus any others the browser lists. */
async function localDatabases(vaultIds: string[]): Promise<{ docs: Set<string>; syncs: Set<string> }> {
  const docs = new Set(vaultIds.map((id) => docDbName('', id)));
  const syncs = new Set(vaultIds.map((id) => syncDbName('', id)));
  try {
    for (const { name } of await indexedDB.databases()) {
      if (name?.startsWith(DOC_PREFIX)) docs.add(name);
      else if (name?.startsWith(SYNC_PREFIX)) syncs.add(name);
    }
  } catch {
    // indexedDB.databases() is not available everywhere; known vaults are covered above.
  }
  return { docs, syncs };
}

/** Rewrites all vault databases with the current local access control settings. Close sessions first. */
export async function resealLocalData(vaultIds: string[]): Promise<void> {
  const { docs, syncs } = await localDatabases(vaultIds);
  for (const name of docs) await resealDocDb(name);
  for (const name of syncs) await new SyncStore(name).reseal();
}

/** Deletes everything this app stores in the browser (used when the local password is forgotten). */
export async function eraseLocalData(): Promise<void> {
  const { docs, syncs } = await localDatabases([]);
  for (const name of [...docs, ...syncs]) await deleteDatabase(name);
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === 'notepad' || k?.startsWith('notepad:')) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
  sessionStorage.clear();
}
