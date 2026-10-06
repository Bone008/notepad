/** URL-safe base64 without padding. Works in browsers and Node (btoa/atob are global in both). */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const pad = (4 - (s.length % 4)) % 4;
  if (pad === 3) throw new Error('invalid base64url length');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isBase64Url(s: string, byteLength?: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  if (byteLength === undefined) return true;
  return s.length === Math.ceil((byteLength * 8) / 6);
}
