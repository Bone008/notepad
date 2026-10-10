import {
  FrameError,
  asBuf,
  decryptFrame,
  encryptFrame,
  fromBase64Url,
  importAesKey,
  randomBytes,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type AesKey,
} from '@notepad/shared';
import { Observable } from './store.js';

/**
 * Optional password protection of everything this app keeps in the browser.
 *
 * A random 256-bit data key encrypts all local values (AES-GCM). The data key itself is stored
 * only wrapped with a key derived from the password (PBKDF2-SHA256). Once unlocked, the data key
 * is held in memory only and never written anywhere: every page load (reload, new tab, restored
 * tab) asks for the password again. Without the config entry below, values are stored in
 * plaintext as before.
 */

export const LOCK_CONFIG_KEY = 'notepad:lock';
/** OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. */
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const DATA_KEY_BYTES = 32;
const WRAP_AAD = 'notepad/local/v1/data-key';
const VALUE_AAD_PREFIX = 'notepad/local/v1|';

interface LockConfig {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  /** encryptFrame(KEK, WRAP_AAD, dataKey) */
  wrappedKey: string;
}

/** A value encrypted with the local data key, as stored in IndexedDB. */
export interface Sealed {
  sealed: Uint8Array;
}

function readConfig(): LockConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(LOCK_CONFIG_KEY);
    return raw ? (JSON.parse(raw) as LockConfig) : null;
  } catch {
    return null;
  }
}

/** Whether local access control is turned on for this browser profile. */
export const lockEnabled = new Observable<boolean>(typeof window !== 'undefined' && readConfig() !== null);

/** Decrypts stored values; set while unlocked. */
let openKey: AesKey | null = null;
/** Encrypt new writes. False while turning protection off (reads still decrypt). */
let sealing = false;

async function deriveKek(password: string, salt: Uint8Array, iterations: number): Promise<AesKey> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', utf8Encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: asBuf(salt), iterations }, base, 256);
  return importAesKey(new Uint8Array(bits));
}

async function unwrap(config: LockConfig, password: string): Promise<Uint8Array | null> {
  const kek = await deriveKek(password, fromBase64Url(config.salt), config.iterations);
  try {
    return await decryptFrame(kek, WRAP_AAD, fromBase64Url(config.wrappedKey));
  } catch (e) {
    if (e instanceof FrameError) return null;
    throw e;
  }
}

async function activateDataKey(raw: Uint8Array): Promise<void> {
  openKey = await importAesKey(raw);
  sealing = true;
}

/** True when protection is on and this tab does not hold the key yet. */
export function isLocked(): boolean {
  return lockEnabled.get() && openKey === null;
}

/** Returns false on a wrong password. */
export async function unlock(password: string): Promise<boolean> {
  const config = readConfig();
  if (!config) return true;
  const raw = await unwrap(config, password);
  if (!raw) return false;
  await activateDataKey(raw);
  return true;
}

export async function verifyPassword(password: string): Promise<boolean> {
  const config = readConfig();
  return config ? (await unwrap(config, password)) !== null : false;
}

/** Forget the key in this tab. The caller reloads the page to drop decrypted state from memory. */
export function lockTab(): void {
  openKey = null;
  sealing = false;
}

/**
 * Turns protection on. `reseal` must rewrite every stored value; it runs after the config is
 * written, so an interruption leaves a readable mix that the next attempt finishes.
 */
export async function enableLock(password: string, reseal: () => Promise<void>): Promise<void> {
  if (readConfig()) throw new Error('local access control is already enabled');
  const salt = randomBytes(SALT_BYTES);
  const raw = randomBytes(DATA_KEY_BYTES);
  const kek = await deriveKek(password, salt, PBKDF2_ITERATIONS);
  const config: LockConfig = {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64Url(salt),
    wrappedKey: toBase64Url(await encryptFrame(kek, WRAP_AAD, raw)),
  };
  localStorage.setItem(LOCK_CONFIG_KEY, JSON.stringify(config));
  await activateDataKey(raw);
  lockEnabled.set(true);
  await reseal();
}

/** Turns protection off: decrypts everything via `reseal`, then removes the config. */
export async function disableLock(password: string, reseal: () => Promise<void>): Promise<boolean> {
  if (!(await verifyPassword(password))) return false;
  sealing = false;
  try {
    await reseal();
  } catch (e) {
    sealing = true;
    throw e;
  }
  localStorage.removeItem(LOCK_CONFIG_KEY);
  lockTab();
  lockEnabled.set(false);
  return true;
}

// ---- value codec ------------------------------------------------------------

function isSealed(v: unknown): v is Sealed {
  return typeof v === 'object' && v !== null && (v as Sealed).sealed instanceof Uint8Array;
}

function requireUnlocked(): void {
  if (isLocked()) throw new Error('local data is locked');
}

/** Encrypts `data` if protection is on; otherwise returns it unchanged. `context` binds it to its slot. */
export async function sealBytes(context: string, data: Uint8Array): Promise<Uint8Array | Sealed> {
  requireUnlocked();
  if (!sealing || !openKey) return data;
  return { sealed: await encryptFrame(openKey, VALUE_AAD_PREFIX + context, data) };
}

/** Accepts both sealed and legacy plaintext values. */
export async function openBytes(context: string, value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (!isSealed(value)) throw new Error('unexpected value in local storage');
  requireUnlocked();
  if (!openKey) throw new Error('local data is encrypted but no key is set');
  return decryptFrame(openKey, VALUE_AAD_PREFIX + context, value.sealed);
}

const SEALED_STRING_PREFIX = '{"sealed":';

export async function sealString(context: string, text: string): Promise<string> {
  const v = await sealBytes(context, utf8Encode(text));
  return isSealed(v) ? JSON.stringify({ sealed: toBase64Url(v.sealed) }) : text;
}

export async function openString(context: string, stored: string): Promise<string> {
  if (!stored.startsWith(SEALED_STRING_PREFIX)) return stored;
  const { sealed } = JSON.parse(stored) as { sealed: string };
  return utf8Decode(await openBytes(context, { sealed: fromBase64Url(sealed) }));
}
