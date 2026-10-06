import { fromBase64Url, isBase64Url, toBase64Url } from './base64url.js';
import {
  VAULT_ID_BYTES,
  VAULT_KEY_BYTES,
  type AesKey,
  asBuf,
  decryptFrame,
  encryptFrame,
  hkdf,
  importAesKey,
  randomBytes,
  utf8Decode,
  utf8Encode,
} from './crypto.js';

/** Crockford base32: no I, L, O, U. */
export const PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIR_CODE_LENGTH = 12; // 12 * 5 bits = 60 bits
export const PAIR_SALT = 'notepad/pair/v1';
export const PAIR_PBKDF2_ITERATIONS = 200_000;
export const PAIR_LOOKUP_BYTES = 16;

/** Canonical form: 12 uppercase symbols, no separators. */
export function generatePairingCode(): string {
  const bytes = randomBytes(PAIR_CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += PAIR_ALPHABET[b & 31]; // 256 % 32 === 0 → uniform
  return out;
}

export function formatPairingCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Normalize user input to canonical form. Accepts lowercase, spaces, dashes, and the
 * Crockford confusables O→0, I→1, L→1. Returns null if the result is not a valid code.
 */
export function normalizePairingCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== PAIR_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!PAIR_ALPHABET.includes(ch)) return null;
  return cleaned;
}

export interface PairingKeys {
  /** Opaque id the server stores the wrapped payload under. */
  lookupId: string;
  wrapKey: AesKey;
}

/** code → PBKDF2 (slows offline guessing) → HKDF → lookup id + wrapping key. */
export async function derivePairingKeys(code: string): Promise<PairingKeys> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', utf8Encode(code), 'PBKDF2', false, ['deriveBits']);
  const prk = new Uint8Array(
    await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: utf8Encode(PAIR_SALT), iterations: PAIR_PBKDF2_ITERATIONS },
      base,
      256,
    ),
  );
  const [lookup, wrap] = await Promise.all([
    hkdf(prk, '', `${PAIR_SALT}/lookup`, PAIR_LOOKUP_BYTES),
    hkdf(prk, '', `${PAIR_SALT}/wrap`, 32),
  ]);
  return { lookupId: toBase64Url(lookup), wrapKey: await importAesKey(wrap) };
}

export interface PairingPayload {
  v: 1;
  vaultId: string;
  /** base64url of the 32-byte vault key */
  key: string;
  name: string;
}

export function pairingAad(lookupId: string): string {
  return `${PAIR_SALT}|${lookupId}`;
}

export async function wrapPairingPayload(keys: PairingKeys, payload: PairingPayload): Promise<Uint8Array<ArrayBuffer>> {
  return encryptFrame(keys.wrapKey, pairingAad(keys.lookupId), utf8Encode(JSON.stringify(payload)));
}

export async function unwrapPairingPayload(keys: PairingKeys, blob: Uint8Array): Promise<PairingPayload> {
  const pt = await decryptFrame(keys.wrapKey, pairingAad(keys.lookupId), asBuf(blob));
  const obj: unknown = JSON.parse(utf8Decode(pt));
  if (!isPairingPayload(obj)) throw new Error('invalid pairing payload');
  return obj;
}

export function isPairingPayload(x: unknown): x is PairingPayload {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o['v'] === 1 &&
    typeof o['vaultId'] === 'string' &&
    isBase64Url(o['vaultId'], VAULT_ID_BYTES) &&
    typeof o['key'] === 'string' &&
    isBase64Url(o['key'], VAULT_KEY_BYTES) &&
    fromBase64Url(o['key']).length === VAULT_KEY_BYTES &&
    typeof o['name'] === 'string'
  );
}
