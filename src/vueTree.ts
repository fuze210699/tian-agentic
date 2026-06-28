// src/vueTree.ts
//
// Walks Vue's component instance tree to build a component ancestry chain.
// Vue 3 attaches the owning component instance to the root DOM element of
// every component, as `el.__vueParentComponent`. Walking up the DOM to find
// that, then walking up `instance.parent`, gives the chain of components
// that rendered a given element.

type VueInstanceLike = {
  type?: { __name?: string; name?: string; __file?: string };
  parent?: VueInstanceLike | null;
};

interface VueAttachedElement extends Element {
  __vueParentComponent?: VueInstanceLike;
}

// Vue's own built-in wrapper components — not useful in an annotation trail,
// filtered out by "smart matching" (see getComponentTree).
const BUILTIN_NAMES = new Set([
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Teleport',
  'Suspense',
  'BaseTransition',
]);

/** Find the nearest Vue component instance that owns `el`, walking up the DOM
 * through shadow boundaries. */
export function getVueInstance(el: Element | null): VueInstanceLike | null {
  let node = el as VueAttachedElement | null;
  while (node) {
    if (node.__vueParentComponent) return node.__vueParentComponent;
    let next: Element | null = node.parentElement;
    if (!next) {
      const root = node.getRootNode();
      next = (root instanceof ShadowRoot ? root.host : null) as Element | null;
    }
    node = next as VueAttachedElement | null;
  }
  return null;
}

function getComponentName(instance: VueInstanceLike): string {
  const type = instance.type || {};
  if (type.__name) return type.__name;
  if (type.name) return type.name;
  if (type.__file) {
    const file = type.__file.split('/').pop() || type.__file;
    return file.replace(/\.vue$/, '');
  }
  return 'Anonymous';
}

/**
 * Build the ancestry chain as a string, e.g. "App > Dashboard > SubmitButton".
 * `smartMatch` drops Vue's built-in wrapper components (Transition, Suspense, …)
 * so the chain reads like the app's own component tree — used for the
 * "Detailed" output format.
 */
export function getComponentTree(instance: VueInstanceLike | null, smartMatch = false): string {
  const names: string[] = [];
  let cur: VueInstanceLike | null | undefined = instance;
  while (cur) {
    const name = getComponentName(cur);
    if (!smartMatch || !BUILTIN_NAMES.has(name)) names.unshift(name);
    cur = cur.parent;
  }
  return names.join(' > ');
}

/**
 * Dev-mode source file, e.g. "src/components/SubmitButton.vue".
 *
 * Vite's @vitejs/plugin-vue (and vue-loader for webpack) attach `__file` to
 * a component's options object in development builds — the same idea as
 * React's `_debugSource`, stripped in production the same way. Unlike
 * React, Vue does not expose a line number here, only the file path.
 */
export function getSourceFile(instance: VueInstanceLike | null): string | undefined {
  return instance?.type?.__file;
}
