import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../src/base64url.js';
import { generateVaultId, generateVaultKey } from '../src/crypto.js';
import {
  PAIR_ALPHABET,
  derivePairingKeys,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  unwrapPairingPayload,
  wrapPairingPayload,
} from '../src/pairing.js';

describe('pairing code', () => {
  it('generates 12 symbols from the Crockford alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePairingCode();
      expect(c).toHaveLength(12);
      for (const ch of c) expect(PAIR_ALPHABET).toContain(ch);
    }
  });

  it('formats as XXXX-XXXX-XXXX', () => {
    expect(formatPairingCode('K7QXM2PA9ZRT')).toBe('K7QX-M2PA-9ZRT');
  });

  it('normalizes user input', () => {
    expect(normalizePairingCode('k7qx m2pa 9zrt')).toBe('K7QXM2PA9ZRT');
    expect(normalizePairingCode('K7QX-M2PA-9ZRT')).toBe('K7QXM2PA9ZRT');
    expect(normalizePairingCode('k7qx-m2pa-9zro')).toBe('K7QXM2PA9ZR0');
    expect(normalizePairingCode('k7qx-m2pa-9zri')).toBe('K7QXM2PA9ZR1');
    expect(normalizePairingCode('k7qx-m2pa-9zrl')).toBe('K7QXM2PA9ZR1');
  });

  it('rejects wrong length and invalid symbols', () => {
    expect(normalizePairingCode('K7QX-M2PA-9ZR')).toBeNull();
    expect(normalizePairingCode('K7QX-M2PA-9ZRTT')).toBeNull();
    expect(normalizePairingCode('K7QX-M2PA-9ZRU')).toBeNull();
    expect(normalizePairingCode('')).toBeNull();
  });
});

describe('pairing keys and payload', () => {
  it('derives deterministic lookup ids and wraps/unwraps the payload', async () => {
    const code = generatePairingCode();
    const a = await derivePairingKeys(code);
    const b = await derivePairingKeys(code);
    expect(a.lookupId).toBe(b.lookupId);
    expect(a.lookupId).toHaveLength(22);

    const payload = { v: 1 as const, vaultId: generateVaultId(), key: toBase64Url(generateVaultKey()), name: 'Team' };
    const blob = await wrapPairingPayload(a, payload);
    expect(await unwrapPairingPayload(b, blob)).toEqual(payload);
  }, 20_000);

  it('fails with a different code', async () => {
    const a = await derivePairingKeys(generatePairingCode());
    const wrong = await derivePairingKeys(generatePairingCode());
    expect(wrong.lookupId).not.toBe(a.lookupId);
    const blob = await wrapPairingPayload(a, {
      v: 1,
      vaultId: generateVaultId(),
      key: toBase64Url(generateVaultKey()),
      name: 'x',
    });
    await expect(unwrapPairingPayload(wrong, blob)).rejects.toThrow();
  }, 20_000);
});
