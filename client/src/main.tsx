import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App, consumeJoinFragment } from './App.js';
import { LOCK_CONFIG_KEY, isLocked } from './core/localLock.js';
import { peekSession } from './core/sessionRegistry.js';
import { Unlock } from './pages/Unlock.js';
import { useVaultList } from './store/vaultList.js';
import './styles.css';

// Debug/testing handle (no secrets beyond what the page already holds).
(window as unknown as { __notepad: unknown }).__notepad = { peekSession };

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  registerSW({ immediate: true });
}

// Local access control was turned on or off in another tab: start over in its new mode.
window.addEventListener('storage', (e) => {
  if (e.key === LOCK_CONFIG_KEY || e.key === null) location.reload();
});

const root = createRoot(document.getElementById('root')!);

async function start(): Promise<void> {
  await useVaultList.persist.rehydrate();
  consumeJoinFragment();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// The local key is held in memory only, so every page load starts locked.
if (isLocked()) {
  root.render(
    <StrictMode>
      <Unlock onUnlocked={() => void start()} />
    </StrictMode>,
  );
} else {
  void start();
}
