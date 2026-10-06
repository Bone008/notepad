import { useEffect, useState, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { filesMap, getFileText, getVaultName, listFiles, metaMap, type FileEntry } from '../core/files.js';
import { userOf, type SessionStatus } from '../core/provider.js';
import type { VaultSession } from '../core/session.js';
import { acquireSession, releaseSession } from '../core/sessionRegistry.js';
import { useVaultList } from '../store/vaultList.js';

export function useVaultSession(vaultId: string, keyB64: string): { session: VaultSession | null; ready: boolean } {
  const [session, setSession] = useState<VaultSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const s = acquireSession({
      vaultId,
      keyB64,
      forceHttp: () => useVaultList.getState().settings.forceHttp,
      user: () => {
        const { deviceName, color } = useVaultList.getState().settings;
        return { name: deviceName, color };
      },
    });
    setSession(s);
    setReady(false);
    void s.ready.then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
      releaseSession(vaultId);
    };
  }, [vaultId, keyB64]);

  return { session, ready };
}

const IDLE_STATUS: SessionStatus = { state: 'offline', transport: null, pending: 0, peers: 1, quotaExceeded: false };

export function useSessionStatus(session: VaultSession | null): SessionStatus {
  return useSyncExternalStore(
    (l) => (session ? session.status.subscribe(l) : () => undefined),
    () => (session ? session.status.get() : IDLE_STATUS),
    () => IDLE_STATUS,
  );
}

/** Subscribes to deep changes in the files map; returns a stable array until something changes. */
export function useFiles(doc: Y.Doc | null): FileEntry[] {
  const [files, setFiles] = useState<FileEntry[]>(() => (doc ? listFiles(doc) : []));
  useEffect(() => {
    if (!doc) return;
    const map = filesMap(doc);
    const update = (): void => setFiles(listFiles(doc));
    update();
    map.observeDeep(update);
    return () => map.unobserveDeep(update);
  }, [doc]);
  return files;
}

export function useVaultName(doc: Y.Doc | null): string {
  const [name, setName] = useState(() => (doc ? getVaultName(doc) : ''));
  useEffect(() => {
    if (!doc) return;
    const meta = metaMap(doc);
    const update = (): void => setName(getVaultName(doc));
    update();
    meta.observe(update);
    return () => meta.unobserve(update);
  }, [doc]);
  return name;
}

export function useFileText(doc: Y.Doc | null, fileId: string | null): Y.Text | null {
  const files = useFiles(doc);
  if (!doc || !fileId) return null;
  if (!files.some((f) => f.id === fileId)) return null;
  return getFileText(doc, fileId);
}

/** Rendered text of a Y.Text, refreshed on each change (throttled to animation frames). */
export function useYTextString(text: Y.Text | null): string {
  const [value, setValue] = useState(() => text?.toString() ?? '');
  useEffect(() => {
    if (!text) {
      setValue('');
      return;
    }
    let raf = 0;
    const update = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setValue(text.toString());
      });
    };
    setValue(text.toString());
    text.observe(update);
    return () => {
      text.unobserve(update);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [text]);
  return value;
}

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  self: boolean;
}

export function usePeers(awareness: Awareness | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    if (!awareness) return;
    const update = (): void => {
      const out: Peer[] = [];
      const seenSessions = new Set<string>();
      const self = userOf(awareness.getLocalState());
      if (self?.sessionId) seenSessions.add(self.sessionId);
      awareness.getStates().forEach((state, clientId) => {
        const u = userOf(state);
        const isSelf = clientId === awareness.clientID;
        // Collapse entries from the same tab (e.g. a stale entry left behind by a refresh).
        if (!isSelf && u?.sessionId) {
          if (seenSessions.has(u.sessionId)) return;
          seenSessions.add(u.sessionId);
        }
        out.push({ clientId, name: u?.name ?? 'Device', color: u?.color ?? '#888', self: isSelf });
      });
      out.sort((a, b) => Number(b.self) - Number(a.self) || a.clientId - b.clientId);
      setPeers(out);
    };
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [awareness]);
  return peers;
}
