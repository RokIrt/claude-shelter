// Indexed-colour software framebuffer. No DOM, no Node: runs in the browser and in
// Node (headless previews, tests). All coordinates are integer logical pixels and
// every primitive clips, so painters never need bounds checks.
//
// FROZEN API: painters and the world depend on it. Add nothing here without the lead.

export class Framebuffer {
  constructor(w, h) {
    this.w = w | 0;
    this.h = h | 0;
    this.buf = new Uint8Array(this.w * this.h);
    this.cx0 = 0; this.cy0 = 0; this.cx1 = this.w; this.cy1 = this.h;
  }

  /** Restrict drawing to a rectangle (intersected with the buffer). */
  setClip(x, y, w, h) {
    this.cx0 = Math.max(0, x | 0); this.cy0 = Math.max(0, y | 0);
    this.cx1 = Math.min(this.w, (x + w) | 0); this.cy1 = Math.min(this.h, (y + h) | 0);
  }
  clearClip() { this.cx0 = 0; this.cy0 = 0; this.cx1 = this.w; this.cy1 = this.h; }

  clear(c = 0) { this.buf.fill(c); }

  px(x, y, c) {
    x |= 0; y |= 0;
    if (x < this.cx0 || y < this.cy0 || x >= this.cx1 || y >= this.cy1) return;
    this.buf[y * this.w + x] = c;
  }

  get(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.buf[y * this.w + x];
  }

  /** Filled rectangle. */
  rect(x, y, w, h, c) {
    x |= 0; y |= 0; w |= 0; h |= 0;
    let x0 = Math.max(x, this.cx0), y0 = Math.max(y, this.cy0);
    let x1 = Math.min(x + w, this.cx1), y1 = Math.min(y + h, this.cy1);
    if (x1 <= x0 || y1 <= y0) return;
    for (let yy = y0; yy < y1; yy++) this.buf.fill(c, yy * this.w + x0, yy * this.w + x1);
  }

  /** 1px rectangle outline. */
  frame(x, y, w, h, c) {
    this.rect(x, y, w, 1, c); this.rect(x, y + h - 1, w, 1, c);
    this.rect(x, y, 1, h, c); this.rect(x + w - 1, y, 1, h, c);
  }

  hline(x, y, len, c) { this.rect(x, y, len, 1, c); }
  vline(x, y, len, c) { this.rect(x, y, 1, len, c); }

  line(x0, y0, x1, y1, c) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Filled disc of radius r (r = 0 is one pixel). */
  disc(cx, cy, r, c) {
    cx |= 0; cy |= 0; r |= 0;
    for (let dy = -r; dy <= r; dy++) {
      const half = Math.floor(Math.sqrt(r * r + r - dy * dy));
      this.rect(cx - half, cy + dy, half * 2 + 1, 1, c);
    }
  }

  /** 1px circle outline. */
  ring(cx, cy, r, c) {
    cx |= 0; cy |= 0; r |= 0;
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      this.px(cx + x, cy + y, c); this.px(cx - x, cy + y, c);
      this.px(cx + x, cy - y, c); this.px(cx - x, cy - y, c);
      this.px(cx + y, cy + x, c); this.px(cx - y, cy + x, c);
      this.px(cx + y, cy - x, c); this.px(cx - y, cy - x, c);
      y++;
      if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
  }

  /** 50% checkerboard fill; phase 0 or 1 picks which half. Good for glows, smoke, glass. */
  dither(x, y, w, h, c, phase = 0) {
    x |= 0; y |= 0; w |= 0; h |= 0;
    const x0 = Math.max(x, this.cx0), y0 = Math.max(y, this.cy0);
    const x1 = Math.min(x + w, this.cx1), y1 = Math.min(y + h, this.cy1);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        if (((xx + yy + phase) & 1) === 0) this.buf[yy * this.w + xx] = c;
      }
    }
  }

  /**
   * Draw a sprite made by sprite(). Index 0 in sprite data is transparent.
   * opts.flipX / opts.flipY mirror it; opts.remap is {fromIndex: toIndex} to recolour.
   */
  blit(spr, x, y, opts) {
    x |= 0; y |= 0;
    const flipX = !!(opts && opts.flipX), flipY = !!(opts && opts.flipY);
    const remap = opts && opts.remap;
    const { w, h, data } = spr;
    for (let sy = 0; sy < h; sy++) {
      const dy = y + sy;
      if (dy < this.cy0 || dy >= this.cy1) continue;
      const row = (flipY ? h - 1 - sy : sy) * w;
      for (let sx = 0; sx < w; sx++) {
        const dx = x + sx;
        if (dx < this.cx0 || dx >= this.cx1) continue;
        let c = data[row + (flipX ? w - 1 - sx : sx)];
        if (c === 0) continue;
        if (remap && remap[c] !== undefined) c = remap[c];
        this.buf[dy * this.w + dx] = c;
      }
    }
  }

  /** Re-light a rectangle: keep each pixel's base colour, set its light mode (0..3). */
  relight(x, y, w, h, mode) {
    x |= 0; y |= 0; w |= 0; h |= 0;
    const x0 = Math.max(x, this.cx0), y0 = Math.max(y, this.cy0);
    const x1 = Math.min(x + w, this.cx1), y1 = Math.min(y + h, this.cy1);
    const m = (mode & 3) << 6;
    for (let yy = y0; yy < y1; yy++) {
      const o = yy * this.w;
      for (let xx = x0; xx < x1; xx++) this.buf[o + xx] = (this.buf[o + xx] & 63) | m;
    }
  }

  /** Copy all pixels from a same-sized framebuffer (for cached static layers). */
  copy(src) { this.buf.set(src.buf); }

  clone() { const f = new Framebuffer(this.w, this.h); f.buf.set(this.buf); return f; }

  /** Expand to packed RGBA through a 256-entry lookup (see paletteRGBA32). */
  toRGBA32(out, lut) {
    const b = this.buf;
    for (let i = 0, n = b.length; i < n; i++) out[i] = lut[b[i]];
  }
}

/**
 * Build a sprite from rows of characters.
 *   sprite(['.aa.', 'abba'], { a: C.STEEL, b: C.WHITE })
 * '.' and ' ' are transparent. Every row must have the same length.
 */
export function sprite(rows, key) {
  const h = rows.length, w = rows[0].length;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    if (row.length !== w) throw new Error(`sprite row ${y} has length ${row.length}, expected ${w}`);
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const c = key[ch];
      if (c === undefined) throw new Error(`sprite: no colour for '${ch}'`);
      data[y * w + x] = c;
    }
  }
  return { w, h, data };
}

/** Deterministic 0..1 hash for procedural texture and effects (no Math.random in painters). */
export function hash(a, b = 0, c = 0) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
