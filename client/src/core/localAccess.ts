import { useSyncExternalStore } from 'react';
import { useVaultList, persistedVaultList } from '../store/vaultList.js';
import { resealLocalData } from './localData.js';
import { disableLock, enableLock, lockEnabled, lockTab } from './localLock.js';
import { closeAllSessions } from './sessionRegistry.js';

/** App-level actions for local access control. */

async function resealEverything(): Promise<void> {
  await closeAllSessions();
  await resealLocalData(useVaultList.getState().vaults.map((v) => v.id));
  // Any state change makes the persist middleware rewrite the vault list with the current codec.
  useVaultList.setState({});
  await persistedVaultList();
}

/** Sessions reopen on demand when a vault is visited again, now with the new codec settings. */
export function turnOnLocalLock(password: string): Promise<void> {
  return enableLock(password, resealEverything);
}

/** Returns false on a wrong password. */
export function turnOffLocalLock(password: string): Promise<boolean> {
  return disableLock(password, resealEverything);
}

/** Forgets the key and reloads, which drops all decrypted state from memory. */
export async function logOut(): Promise<void> {
  await closeAllSessions();
  await persistedVaultList();
  lockTab();
  location.reload();
}

export function useLockEnabled(): boolean {
  return useSyncExternalStore(
    (l) => lockEnabled.subscribe(l),
    () => lockEnabled.get(),
  );
}
