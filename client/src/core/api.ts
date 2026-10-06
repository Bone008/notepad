import { toBase64Url } from '@notepad/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    throw new ApiError(0, 'network');
  }
  let body: unknown = null;
  try {
    body = res.status === 204 ? null : await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? 'error');
  return body as T;
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export function createVaultOnServer(baseUrl: string, vaultId: string, token: string, secret: string): Promise<void> {
  return call(`${baseUrl}/api/vaults`, json({ vaultId, token }, { 'X-Notepad-Create-Secret': secret }));
}

export function postPairing(baseUrl: string, lookupId: string, blob: Uint8Array): Promise<{ expiresAt: number }> {
  return call(`${baseUrl}/api/pair`, json({ lookupId, blob: toBase64Url(blob) }));
}

export async function claimPairing(baseUrl: string, lookupId: string): Promise<string | null> {
  try {
    const r = await call<{ blob: string }>(`${baseUrl}/api/pair/${lookupId}`, { method: 'GET' });
    return r.blob;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function pairingClaimed(baseUrl: string, lookupId: string): Promise<boolean | null> {
  try {
    const r = await call<{ claimed: boolean }>(`${baseUrl}/api/pair/${lookupId}/claimed`, { method: 'GET' });
    return r.claimed;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
