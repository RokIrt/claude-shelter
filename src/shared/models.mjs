// Model registry: which models get which machine. Pure, isomorphic.
import { C } from '../gfx/palette.mjs';

/** Built-in machines, in display order. `match` tests a raw model id or a plan display name. */
export const BUILTIN_MODELS = Object.freeze([
  { key: 'fable', label: 'Fable', design: 'fable', match: /fable/i, style: { accent: C.VIOLET_L, accent2: C.CYAN, variant: 0 } },
  { key: 'opus', label: 'Opus', design: 'opus', match: /opus/i, style: { accent: C.COPPER_L, accent2: C.BRASS, variant: 0 } },
  { key: 'sonnet', label: 'Sonnet', design: 'sonnet', match: /sonnet/i, style: { accent: C.BLUE_L, accent2: C.HAZARD, variant: 0 } },
  { key: 'haiku', label: 'Haiku', design: 'haiku', match: /haiku/i, style: { accent: C.GREEN_L, accent2: C.MINT, variant: 0 } },
]);

const GENERIC_ACCENTS = [
  [C.PINK, C.TEAL], [C.TEAL, C.AMBER_L], [C.RED_L, C.STEEL_LL], [C.SKY, C.PINK],
  [C.BRASS, C.GREEN_L], [C.CYAN_L, C.VIOLET_L],
];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Turn a raw model id ('claude-fable-5-2') or plan display name ('Fable') into a model key.
 * Unknown models get a key from their family name: 'claude-nova-9-1' -> 'nova'.
 */
export function modelKeyOf(idOrName, extraModels = []) {
  const s = String(idOrName ?? '').trim();
  if (!s) return 'unknown';
  for (const m of [...extraModels, ...BUILTIN_MODELS]) {
    const re = m.match instanceof RegExp ? m.match : m.match ? new RegExp(m.match, 'i') : null;
    if (re ? re.test(s) : s.toLowerCase() === m.key) return m.key;
  }
  const parts = s.toLowerCase().replace(/^claude[-_ ]?/, '').split(/[^a-z]+/).filter(Boolean);
  return parts[0] || s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Model definition (label, design, style) for a key. Unknown keys get a generic machine
 * whose colours and shape variant are picked deterministically from the key.
 * extraModels: user-configured entries [{key, label?, match?, design?, style?}].
 */
export function modelDef(key, extraModels = []) {
  const found = [...extraModels, ...BUILTIN_MODELS].find((m) => m.key === key);
  const h = hashStr(key);
  const [accent, accent2] = GENERIC_ACCENTS[h % GENERIC_ACCENTS.length];
  const generic = { accent, accent2, variant: (h >>> 8) % 4 };
  if (found) {
    return {
      key,
      label: found.label ?? key[0].toUpperCase() + key.slice(1),
      design: found.design ?? 'generic',
      style: { ...generic, ...(found.style ?? {}) },
    };
  }
  return { key, label: key[0].toUpperCase() + key.slice(1), design: 'generic', style: generic };
}

export const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const zeroRate = () => ({ input: 0, output: 0, cacheRead: 0 });
