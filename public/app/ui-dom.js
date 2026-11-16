// Tiny DOM helpers for the HUD. The HUD is built once and then patched in place:
// state arrives four times a second, and rebuilding nodes would kill focus, hover,
// running animations and half-finished clicks.

/** Create an element. props: class, text, dataset, on<event>, anything else is an attribute. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

/** Set the text of a leaf element, touching the DOM only when it changed. */
export function text(el, value) {
  const s = value == null ? '' : String(value);
  if (el.__text !== s) { el.__text = s; el.textContent = s; }
}

/** Set or remove an attribute, touching the DOM only when it changed. */
export function attr(el, name, value) {
  const v = value == null || value === false ? null : value === true ? '' : String(value);
  if (el.getAttribute(name) === v) return;
  if (v === null) el.removeAttribute(name); else el.setAttribute(name, v);
}

export function show(el, on) { if (el.hidden === !!on) el.hidden = !on; }

/** Set a CSS custom property (or any style property), only when it changed. */
export function style(el, name, value) {
  const key = `__s_${name}`;
  if (el[key] === value) return;
  el[key] = value;
  if (value == null) el.style.removeProperty(name); else el.style.setProperty(name, value);
}

/**
 * Reconcile the children of `parent` (which must hold nothing else) with `items`.
 * Nodes are reused by key, so existing ones keep their focus and animations and only
 * genuinely new ones play an entry animation.
 * @param {(item:any, index:number) => string} keyOf
 * @param {(item:any) => HTMLElement} create
 * @param {(node:HTMLElement, item:any, fresh:boolean) => void} update
 */
export function keyed(parent, items, keyOf, create, update) {
  const map = parent.__keyed ?? (parent.__keyed = new Map());
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = keyOf(item, i);
    if (seen.has(key)) continue;                       // duplicate keys: first one wins
    let node = map.get(key);
    const fresh = !node;
    if (fresh) { node = create(item); map.set(key, node); }
    update(node, item, fresh);
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (node !== want) parent.insertBefore(node, want);
    prev = node;
    seen.add(key);
  }
  for (const [key, node] of map) {
    if (!seen.has(key)) { node.remove(); map.delete(key); }
  }
}
