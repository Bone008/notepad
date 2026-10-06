// Generates PWA PNG icons (a white "N" on the accent color) without any image dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [0x2f, 0x6f, 0xde, 255];
const FG = [255, 255, 255, 255];

// "N" glyph in a 64x64 design grid: two vertical bars and a diagonal.
function glyph(u, v) {
  const inLeft = u >= 18 && u < 24 && v >= 18 && v < 46;
  const inRight = u >= 40 && u < 46 && v >= 18 && v < 46;
  const d = (v - 18) / 28; // 0..1 along the diagonal
  const dx = 18 + d * 22;
  const inDiag = v >= 18 && v < 46 && u >= dx && u < dx + 6.5;
  return inLeft || inRight || inDiag;
}

function icon(size, { maskable }) {
  const pad = maskable ? 0.1 : 0; // maskable icons need safe-zone padding
  const radius = maskable ? 0 : size * 0.22;
  return png(size, (x, y) => {
    // rounded corners (transparent outside) unless maskable
    if (!maskable) {
      const cx = Math.min(Math.max(x, radius), size - radius);
      const cy = Math.min(Math.max(y, radius), size - radius);
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) return [0, 0, 0, 0];
    }
    const inner = size * (1 - 2 * pad);
    const u = ((x - size * pad) / inner) * 64;
    const v = ((y - size * pad) / inner) * 64;
    return glyph(u, v) ? FG : BG;
  });
}

const out = new URL('../client/public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), icon(192, { maskable: false }));
writeFileSync(new URL('icon-512.png', out), icon(512, { maskable: false }));
writeFileSync(new URL('icon-512-maskable.png', out), icon(512, { maskable: true }));
console.log('icons written');
