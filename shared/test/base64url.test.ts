import { describe, expect, it } from 'vitest';
import { fromBase64Url, isBase64Url, toBase64Url } from '../src/base64url.js';

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding', () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33, 1000]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const s = toBase64Url(bytes);
      expect(s).not.toMatch(/[+/=]/);
      expect(fromBase64Url(s)).toEqual(bytes);
    }
  });

  it('rejects invalid input', () => {
    expect(() => fromBase64Url('abc+')).toThrow();
    expect(() => fromBase64Url('a')).toThrow();
  });

  it('checks encoded length for a byte count', () => {
    expect(isBase64Url(toBase64Url(new Uint8Array(16)), 16)).toBe(true);
    expect(isBase64Url(toBase64Url(new Uint8Array(32)), 16)).toBe(false);
    expect(isBase64Url('not valid!', 16)).toBe(false);
  });
});
