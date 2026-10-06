import { useSyncExternalStore } from 'react';

export type Route = { name: 'home' } | { name: 'vault'; vaultId: string; fileId: string | null } | { name: 'settings' };

export function parseRoute(pathname: string, search: string): Route {
  const m = /^\/v\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (m && m[1]) {
    const fileId = new URLSearchParams(search).get('f');
    return { name: 'vault', vaultId: m[1], fileId };
  }
  if (pathname === '/settings') return { name: 'settings' };
  return { name: 'home' };
}

const listeners = new Set<() => void>();
let cached: { key: string; route: Route } | null = null;

function snapshot(): Route {
  const key = location.pathname + location.search;
  if (!cached || cached.key !== key) cached = { key, route: parseRoute(location.pathname, location.search) };
  return cached.route;
}

function notify(): void {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  notify();
}

export function vaultPath(vaultId: string, fileId?: string | null): string {
  return `/v/${vaultId}${fileId ? `?f=${encodeURIComponent(fileId)}` : ''}`;
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    snapshot,
    snapshot,
  );
}
