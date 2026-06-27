import type { Rect } from './types';

export function getElementPath(el: Element, maxDepth = 6): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < maxDepth) {
    parts.unshift(describeElement(node));
    if (node.tagName.toLowerCase() === 'body') break;
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

export function getFullPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    const index = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    if (tag === 'body') break;
    node = parent;
  }
  return parts.join(' > ');
}

export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = firstMeaningfulClass(el);
  return cls ? `${tag}.${cls}` : tag;
}

function firstMeaningfulClass(el: Element): string | null {
  const classes = Array.from(el.classList).filter(
    (c) => !c.startsWith('v-') && c !== 'router-link-active' && c !== 'tian-annotate-hover-outline'
  );
  return classes[0] ?? null;
}

export function getCssClasses(el: Element): string {
  return Array.from(el.classList)
    .filter((c) => c !== 'tian-annotate-hover-outline')
    .join(' ');
}

export function getBoundingBox(el: Element): Rect {
  const r = el.getBoundingClientRect();
  const fixed = isFixedOrSticky(el);
  return {
    x: Math.round(fixed ? r.x : r.x + window.scrollX),
    y: Math.round(fixed ? r.y : r.y + window.scrollY),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/** A `position: sticky` element only behaves like `fixed` (viewport-anchored)
 * while it is actually engaged/"stuck" — e.g. a header that sits below a
 * hero banner is in normal document flow until you scroll past the banner.
 * Treating every sticky element as permanently viewport-anchored breaks the
 * moment its stuck state changes after the annotation was created (the
 * stored coordinates no longer match where the element visually sits).
 *
 * Detect the current state by comparing the element's rendered edge to its
 * resolved sticky offset (e.g. `top: 0`): when stuck, the browser clamps
 * that edge to sit exactly at the offset; when not yet stuck, the edge sits
 * wherever normal flow placed it, which only coincides with the offset by
 * chance. (A "force position:static and compare" trick was tried first, but
 * gives a false negative right at the moment a from-the-top sticky element
 * starts out already at its clamp point, before any scrolling happens.) */
function isStickyCurrentlyStuck(el: Element): boolean {
  const cs = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  const top = parseFloat(cs.top);
  if (!Number.isNaN(top) && Math.abs(rect.top - top) < 1) return true;

  const bottom = parseFloat(cs.bottom);
  if (!Number.isNaN(bottom) && Math.abs(window.innerHeight - rect.bottom - bottom) < 1) return true;

  const left = parseFloat(cs.left);
  if (!Number.isNaN(left) && Math.abs(rect.left - left) < 1) return true;

  const right = parseFloat(cs.right);
  if (!Number.isNaN(right) && Math.abs(window.innerWidth - rect.right - right) < 1) return true;

  return false;
}

export function isFixedOrSticky(el: Element): boolean {
  const pos = window.getComputedStyle(el).position;
  if (pos === 'fixed') return true;
  if (pos === 'sticky') return isStickyCurrentlyStuck(el);
  return false;
}

const STYLE_KEYS = [
  'display',
  'position',
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'padding',
  'margin',
  'width',
  'height',
  'gap',
] as const;

export function getComputedStylesSummary(el: Element): string {
  const computed = window.getComputedStyle(el);
  return STYLE_KEYS.map((key) => `${key}: ${computed[key as keyof CSSStyleDeclaration]}`).join('; ');
}

export function getNearbyText(el: Element, max = 140): string {
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  if (text) return text.length > max ? `${text.slice(0, max)}…` : text;
  const parent = el.parentElement;
  if (!parent) return '';
  const parentText = (parent.textContent || '').trim().replace(/\s+/g, ' ');
  return parentText.length > max ? `${parentText.slice(0, max)}…` : parentText;
}

export function getAccessibilitySummary(el: Element): string | undefined {
  const role = el.getAttribute('role');
  const ariaAttrs = Array.from(el.attributes)
    .filter((a) => a.name.startsWith('aria-'))
    .map((a) => `${a.name}="${a.value}"`);
  const parts = [role ? `role="${role}"` : null, ...ariaAttrs].filter(Boolean) as string[];
  return parts.length ? parts.join(' ') : undefined;
}

/** An element must have at least this fraction of its own area inside the
 * drag rect to count as "selected" — a bare overlap check would also match
 * any ancestor wrapper (nav, ul, ...) just because a selected child sits
 * inside it, even though most of the wrapper itself lies outside the
 * drag area. */
const MIN_CONTAINMENT_RATIO = 0.6;

export function getElementsInRect(rect: { left: number; top: number; width: number; height: number }, maxResults = 10): Element[] {
  const candidates = Array.from(document.querySelectorAll('*')).filter((el) => {
    if (el === document.body || el === document.documentElement) return false;
    if (el.closest('.tian-annotate-ignore')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const overlapX = Math.max(0, Math.min(r.right, rect.left + rect.width) - Math.max(r.left, rect.left));
    const overlapY = Math.max(0, Math.min(r.bottom, rect.top + rect.height) - Math.max(r.top, rect.top));
    const overlapArea = overlapX * overlapY;
    if (overlapArea <= 0) return false;
    return overlapArea / (r.width * r.height) >= MIN_CONTAINMENT_RATIO;
  });

  // Drop wrappers that merely contain another matched element (e.g. don't
  // also report <nav>/<ul> once their <li> children already matched) — keep
  // only the most specific elements actually inside the drag area.
  const leaves = candidates.filter(
    (el) => !candidates.some((other) => other !== el && el.contains(other))
  );

  return leaves.slice(0, maxResults);
}

/** Bounding box covering every given element, in document coordinates — used
 * to draw one combined highlight around a multi-select group instead of an
 * outline per element (which reads as N separate selections rather than
 * one group). */
export function getUnionRect(els: Element[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.right);
    maxY = Math.max(maxY, r.bottom);
  }
  return {
    x: Math.round(minX + window.scrollX),
    y: Math.round(minY + window.scrollY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'img', 'video', 'audio', 'label']);
const SVG_NS = 'http://www.w3.org/2000/svg';

function hasVisualIdentity(el: Element): boolean {
  const cs = window.getComputedStyle(el);
  const hasBackground = cs.backgroundImage !== 'none' || !/^rgba?\(0,\s*0,\s*0,\s*0\)$/.test(cs.backgroundColor);
  const hasBorder = (['Top', 'Right', 'Bottom', 'Left'] as const).some((side) => {
    const width = parseFloat(cs[`border${side}Width` as keyof CSSStyleDeclaration] as string);
    return width > 0 && cs[`border${side}Style` as keyof CSSStyleDeclaration] !== 'none';
  });
  const hasShadow = cs.boxShadow !== 'none';
  return hasBackground || hasBorder || hasShadow;
}

function hasOwnText(el: Element): boolean {
  return Array.from(el.childNodes).some((n) => n.nodeType === 3 && !!(n.textContent || '').trim());
}

/**
 * Resolve the DOM target a user is pointing at to the nearest element that
 * actually looks like a UI component — a button, a card with its own
 * background/border, a text node's containing element — instead of
 * whatever raw node happens to be under the cursor (often a layout-only
 * `<div>`/`<span>` wrapper, or a `<path>` inside an icon `<svg>`). Without
 * this, hovering flickers between near-identical nested wrappers as the
 * cursor moves by a single pixel, which reads as noisy/twitchy rather than
 * a clean "this is the thing you're pointing at" highlight.
 *
 * Pass `precise: true` (e.g. wired to the Alt/Option key) to skip this and
 * return the raw target, for the rare case the resolved ancestor isn't
 * actually what the user wants.
 */
export function getMeaningfulTarget(el: Element, options: { precise?: boolean; maxDepth?: number } = {}): Element {
  if (options.precise) return el;
  const maxDepth = options.maxDepth ?? 6;

  // Collapse icon-fragment nodes (<path>, <circle>, <g>, ...) up to the
  // enclosing <svg> — those fragments are never meaningful on their own.
  let start: Element = el;
  while (start.namespaceURI === SVG_NS && start.tagName.toLowerCase() !== 'svg' && start.parentElement) {
    start = start.parentElement;
  }

  let candidate = start;
  let depth = 0;
  while (depth < maxDepth) {
    const tag = candidate.tagName.toLowerCase();
    // Note: deliberately no `tag === 'svg'` shortcut here — an icon `<svg>`
    // with no fill/border of its own isn't visually distinct, so it should
    // keep climbing to whatever wraps it (typically the actual button).
    if (INTERACTIVE_TAGS.has(tag) || hasVisualIdentity(candidate) || hasOwnText(candidate)) {
      return candidate;
    }
    const parent = candidate.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    candidate = parent;
    depth++;
  }
  // No confidently "meaningful" ancestor found within range — fall back to
  // the most specific thing we have (the svg-collapsed start, or the
  // original element) rather than guessing some arbitrary outer wrapper.
  return start;
}
