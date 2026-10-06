import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface VaultRecord {
  id: string;
  keyB64: string;
  name: string;
  lastOpened: number;
}

export interface Settings {
  forceHttp: boolean;
  createSecret: string | null;
  deviceName: string;
  color: string;
}

interface VaultListState {
  vaults: VaultRecord[];
  settings: Settings;
  addVault(v: Omit<VaultRecord, 'lastOpened'>): void;
  removeVault(id: string): void;
  touchVault(id: string, name?: string): void;
  setSettings(patch: Partial<Settings>): void;
}

export const PALETTE = ['#e06c75', '#e5a040', '#98c379', '#3fb3b3', '#61afef', '#a66bda', '#d670b7', '#5c8fbd'];

function randomName(): string {
  const adjectives = ['Quick', 'Calm', 'Bright', 'Bold', 'Quiet', 'Swift', 'Warm', 'Keen'];
  const nouns = ['Otter', 'Falcon', 'Maple', 'Comet', 'Harbor', 'Pine', 'Lynx', 'Delta'];
  const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)] ?? arr[0]!;
  return `${pick(adjectives)} ${pick(nouns)}`;
}

export const useVaultList = create<VaultListState>()(
  persist(
    (set) => ({
      vaults: [],
      settings: {
        forceHttp: false,
        createSecret: null,
        deviceName: randomName(),
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
      },
      addVault: (v) =>
        set((s) => {
          if (s.vaults.some((x) => x.id === v.id)) return s;
          return { vaults: [{ ...v, lastOpened: Date.now() }, ...s.vaults] };
        }),
      removeVault: (id) => set((s) => ({ vaults: s.vaults.filter((v) => v.id !== id) })),
      touchVault: (id, name) =>
        set((s) => ({
          vaults: s.vaults
            .map((v) => (v.id === id ? { ...v, lastOpened: Date.now(), name: name ?? v.name } : v))
            .sort((a, b) => b.lastOpened - a.lastOpened),
        })),
      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    }),
    { name: 'notepad' },
  ),
);

export function useVault(id: string): VaultRecord | undefined {
  return useVaultList((s) => s.vaults.find((v) => v.id === id));
}
