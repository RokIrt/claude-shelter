// Token Shelter palette: 64 base colours x 4 light modes = 256 entries (VGA style).
//
// A framebuffer pixel is one byte: low 6 bits = base colour (C.*), high 2 bits =
// light mode (LIGHT.*). Painters always draw with base colours; the world relights
// whole regions afterwards with fb.relight(x, y, w, h, mode). Anything drawn AFTER
// a relight keeps full brightness, which is how emissive things (fire, beacons,
// screens that are still powered) glow in a dark room.
//
// FROZEN: every painter depends on these indices. Do not reorder or edit.

export const C = Object.freeze({
  BLACK: 0, INK: 1,
  ROCK_D: 2, ROCK: 3, ROCK_L: 4, DIRT: 5, SAND: 6,
  STEEL_DD: 7, STEEL_D: 8, STEEL: 9, STEEL_L: 10, STEEL_LL: 11, WHITE: 12,
  WALL_D: 13, WALL: 14, WALL_L: 15,
  AMBER_D: 16, AMBER: 17, AMBER_L: 18, CREAM: 19,
  RED_D: 20, RED: 21, RED_L: 22, ORANGE: 23, YELLOW: 24,
  GREEN_DD: 25, GREEN_D: 26, GREEN: 27, GREEN_L: 28, MINT: 29,
  TEAL_D: 30, TEAL: 31, CYAN: 32, CYAN_L: 33,
  BLUE_D: 34, BLUE: 35, BLUE_L: 36, SKY: 37,
  VIOLET_D: 38, VIOLET: 39, VIOLET_L: 40, PINK: 41,
  COPPER_D: 42, COPPER: 43, COPPER_L: 44, BRASS: 45,
  TAN: 46, LEATHER: 47, WOOD: 48,
  SMOKE_D: 49, SMOKE: 50, SMOKE_L: 51,
  GLASS: 52, GLASS_L: 53,
  NIGHT_D: 54, NIGHT: 55, DUSK: 56, MOON: 57,
  GRASS_D: 58, GRASS: 59,
  CRATE: 60, PACKAGE: 61, HAZARD: 62, MAGENTA: 63,
});

export const BASE_HEX = Object.freeze([
  '#000000', '#0d0b10',
  '#1c1410', '#2e2018', '#45301f', '#5c4026', '#8a6a3c',
  '#1b2026', '#2c343d', '#4a5560', '#76828c', '#aab4bb', '#e8ecea',
  '#3a2616', '#5a3a1e', '#7a5228',
  '#8f4e12', '#d98a1f', '#f7c04a', '#fbe9a6',
  '#5e1410', '#b3261a', '#ee4b2b', '#f47a1e', '#fad338',
  '#0b2a14', '#145a22', '#25a03a', '#6fe05a', '#c6f7b0',
  '#0e3b46', '#178a8e', '#46d6d0', '#b4f5ee',
  '#152456', '#2a4fb0', '#5b8ef0', '#a8cdfa',
  '#2e1650', '#6a35b0', '#a873ee', '#f0a8e8',
  '#5a2a14', '#a85a2a', '#dc8e4c', '#c9a13a',
  '#c79a6b', '#7a3e22', '#96602e',
  '#2a2a2e', '#55555c', '#8c8c94',
  '#3a6a78', '#8fd0d8',
  '#0a0f24', '#16204a', '#3c2a5c', '#f2f0d0',
  '#24401c', '#3f6a26',
  '#b07a36', '#d8c8a0', '#f2c40f', '#ff3ea5',
]);

/** Light modes (the high two bits of a framebuffer byte). */
export const LIGHT = Object.freeze({
  NORMAL: 0,     // warm, fully lit
  AMBER: 1,      // pit-stop: dim amber emergency lamps (session limit tripped)
  EMERGENCY: 2,  // emergency power: dark red (weekly limit reached)
  DARK: 3,       // unpowered / night
});

function tint(r, g, b, mode) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (mode === LIGHT.AMBER) {
    return [
      Math.min(255, 0.80 * (0.45 * r + 0.55 * lum * 1.15)),
      Math.min(255, 0.80 * (0.38 * g + 0.42 * lum)),
      Math.min(255, 0.80 * (0.22 * b + 0.10 * lum)),
    ];
  }
  if (mode === LIGHT.EMERGENCY) {
    return [
      Math.min(255, 0.24 * r + 0.62 * lum),
      Math.min(255, 0.10 * g + 0.13 * lum),
      Math.min(255, 0.09 * b + 0.11 * lum),
    ];
  }
  if (mode === LIGHT.DARK) {
    return [0.20 * r + 0.05 * lum, 0.20 * g + 0.08 * lum, 0.22 * b + 0.14 * lum];
  }
  return [r, g, b];
}

/** 256 RGB triples: PALETTE_RGB[i*3 .. i*3+2]. */
export const PALETTE_RGB = (() => {
  const out = new Uint8Array(256 * 3);
  for (let mode = 0; mode < 4; mode++) {
    for (let i = 0; i < 64; i++) {
      const hex = BASE_HEX[i];
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const [tr, tg, tb] = tint(r, g, b, mode);
      const o = (mode * 64 + i) * 3;
      out[o] = Math.round(tr); out[o + 1] = Math.round(tg); out[o + 2] = Math.round(tb);
    }
  }
  return out;
})();

/** 256 packed little-endian RGBA values for writing through a Uint32Array view of ImageData. */
export function paletteRGBA32() {
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    out[i] = (0xff000000 | (PALETTE_RGB[i * 3 + 2] << 16) | (PALETTE_RGB[i * 3 + 1] << 8) | PALETTE_RGB[i * 3]) >>> 0;
  }
  return out;
}

/** CSS colour string of a base colour (for DOM chrome that should match the art). */
export function css(index, mode = 0) {
  const o = (mode * 64 + (index & 63)) * 3;
  return `rgb(${PALETTE_RGB[o]},${PALETTE_RGB[o + 1]},${PALETTE_RGB[o + 2]})`;
}
