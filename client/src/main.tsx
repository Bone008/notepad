import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App, consumeJoinFragment } from './App.js';
import { peekSession } from './core/sessionRegistry.js';
import './styles.css';

consumeJoinFragment();

// Debug/testing handle (no secrets beyond what the page already holds).
(window as unknown as { __notepad: unknown }).__notepad = { peekSession };

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  registerSW({ immediate: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
