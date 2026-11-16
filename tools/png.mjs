// Minimal indexed-colour PNG writer (Node only) so framebuffers can be previewed
// headlessly:  savePng(fb, 'out/thing.png', 4)  then open the file with an image viewer.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PALETTE_RGB } from '../src/gfx/palette.mjs';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode a Framebuffer as a PNG Buffer, each logical pixel drawn scale x scale. */
export function encodePng(fb, scale = 1) {
  const W = fb.w * scale, H = fb.h * scale;
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / scale);
    const o = y * (W + 1);
    raw[o] = 0;
    for (let x = 0; x < W; x++) raw[o + 1 + x] = fb.buf[sy * fb.w + Math.floor(x / scale)];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from(PALETTE_RGB)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Write a Framebuffer to a PNG file (creates the directory). */
export function savePng(fb, path, scale = 3) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(fb, scale));
  return path;
}
