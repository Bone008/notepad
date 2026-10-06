import { toBase64Url } from './base64url.js';

export const FRAME_VERSION = 1;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const VAULT_KEY_BYTES = 32;
export const VAULT_ID_BYTES = 16;
/** Minimum length of a well-formed frame: version + nonce + GCM tag. */
export const MIN_FRAME_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

export type FrameKind = 'update' | 'snapshot' | 'awareness';

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

/** Environment-neutral alias: resolves to the DOM CryptoKey in browsers and Node's webcrypto.CryptoKey on the server. */
export type AesKey = Awaited<ReturnType<typeof subtle.importKey>>;

/** Re-type a Uint8Array for WebCrypto's BufferSource (which rejects SharedArrayBuffer-backed views). */
export function asBuf(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  return u8 as Uint8Array<ArrayBuffer>;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function generateVaultKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(VAULT_KEY_BYTES);
}

export function generateVaultId(): string {
  return toBase64Url(randomBytes(VAULT_ID_BYTES));
}

export async function hkdf(
  ikm: Uint8Array,
  salt: string,
  info: string,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle.importKey('raw', asBuf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function importAesKey(raw: Uint8Array): Promise<AesKey> {
  return subtle.importKey('raw', asBuf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.digest('SHA-256', asBuf(data)));
}

export interface VaultKeys {
  vaultId: string;
  /** AES-GCM key for updates, snapshots and awareness. Non-extractable. */
  contentKey: AesKey;
  /** Bearer token presented to the server. The server only stores its SHA-256. */
  authToken: string;
}

/** Derive everything the client needs from the 32-byte vault key. Deterministic. */
export async function deriveVaultKeys(vaultId: string, vaultKey: Uint8Array): Promise<VaultKeys> {
  if (vaultKey.length !== VAULT_KEY_BYTES) throw new Error('vault key must be 32 bytes');
  const [contentRaw, authRaw] = await Promise.all([
    hkdf(vaultKey, '', 'notepad/v1/content', 32),
    hkdf(vaultKey, '', 'notepad/v1/auth', 32),
  ]);
  return {
    vaultId,
    contentKey: await importAesKey(contentRaw),
    authToken: toBase64Url(authRaw),
  };
}

export function frameAad(vaultId: string, kind: FrameKind): string {
  return `${vaultId}|${kind}`;
}

/**
 * frame = version(1) || nonce(12) || AES-GCM(ciphertext || tag).
 * Random 96-bit nonces are safe here: a vault sees far fewer than 2^32 frames per key.
 */
export async function encryptFrame(key: AesKey, aad: string, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(aad), tagLength: TAG_BYTES * 8 },
      key,
      asBuf(plaintext),
    ),
  );
  const out = new Uint8Array(1 + NONCE_BYTES + ct.length);
  out[0] = FRAME_VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_BYTES);
  return out;
}

export class FrameError extends Error {}

export async function decryptFrame(key: AesKey, aad: string, frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (frame.length < MIN_FRAME_BYTES) throw new FrameError('frame too short');
  if (frame[0] !== FRAME_VERSION) throw new FrameError(`unsupported frame version ${frame[0]}`);
  const nonce = frame.subarray(1, 1 + NONCE_BYTES);
  const ct = frame.subarray(1 + NONCE_BYTES);
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: asBuf(nonce), additionalData: enc.encode(aad), tagLength: TAG_BYTES * 8 },
      key,
      asBuf(ct),
    );
    return new Uint8Array(pt);
  } catch {
    throw new FrameError('decryption failed');
  }
}

export function utf8Encode(s: string): Uint8Array<ArrayBuffer> {
  return enc.encode(s) as Uint8Array<ArrayBuffer>;
}

export function utf8Decode(b: Uint8Array): string {
  return dec.decode(b);
}
