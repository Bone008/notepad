import { useEffect } from 'react';
import { parseJoinLink } from '@notepad/shared';
import { Home } from './pages/Home.js';
import { Settings } from './pages/Settings.js';
import { VaultView } from './pages/VaultView.js';
import { navigate, useRoute, vaultPath } from './router.js';
import { useVaultList } from './store/vaultList.js';

/** Handles #join=… fragments: adds the vault locally and strips the key from the URL. */
export function consumeJoinFragment(): boolean {
  const info = parseJoinLink(location.hash);
  if (!info) return false;
  useVaultList.getState().addVault({ id: info.vaultId, keyB64: info.keyB64, name: 'Shared vault' });
  history.replaceState(null, '', vaultPath(info.vaultId));
  return true;
}

export function App() {
  const route = useRoute();

  useEffect(() => {
    const onHash = (): void => {
      if (consumeJoinFragment()) navigate(location.pathname + location.search, true);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  switch (route.name) {
    case 'vault':
      return <VaultView vaultId={route.vaultId} fileId={route.fileId} />;
    case 'settings':
      return <Settings />;
    default:
      return <Home />;
  }
}
