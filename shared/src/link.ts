import { isBase64Url } from './base64url.js';
import { VAULT_ID_BYTES, VAULT_KEY_BYTES } from './crypto.js';

export interface JoinInfo {
  vaultId: string;
  keyB64: string;
}

/** The key lives in the fragment, which browsers never send to the server. */
export function buildJoinLink(origin: string, info: JoinInfo): string {
  return `${origin.replace(/\/$/, '')}/#join=${info.vaultId}.${info.keyB64}`;
}

/** Accepts "#join=…", "join=…" or a full URL containing such a fragment. */
export function parseJoinLink(text: string): JoinInfo | null {
  const t = text.trim();
  const hashIdx = t.indexOf('#');
  const frag = hashIdx >= 0 ? t.slice(hashIdx + 1) : t;
  const m = /^join=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(frag);
  if (!m) return null;
  const [, vaultId, keyB64] = m;
  if (!vaultId || !keyB64) return null;
  if (!isBase64Url(vaultId, VAULT_ID_BYTES) || !isBase64Url(keyB64, VAULT_KEY_BYTES)) return null;
  return { vaultId, keyB64 };
}
