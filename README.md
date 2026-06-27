# tian-annotate-vue

Click-to-annotate visual feedback toolbar for Vue 3 apps. Click an element,
write a note, copy structured markdown into Claude Code, Cursor, or any
AI coding agent.

## Install

```bash
npm install tian-annotate-vue
```

## Usage

```vue
<script setup>
import { TianAnnotate } from 'tian-annotate-vue';
import 'tian-annotate-vue/style.css';
</script>

<template>
  <YourApp />
  <TianAnnotate />
</template>
```

The CSS import is required — the toolbar's styles ship as a separate
`style.css` file rather than being auto-injected, so the component will
render unstyled (or not visibly at all) without it. Importing it once,
anywhere in your app's entry point, is enough.

A floating `+` button appears bottom-right. Click it to activate, then
click anything on the page to annotate it.

## Output format

Each annotation captures the comment plus enough DOM and component context
for an AI agent to locate the element in the codebase: a CSS selector
(`elementPath`/`fullPath`), the element's tag and classes, its bounding box,
nearby text, accessibility attributes, and the Vue component ancestry chain
that rendered it (`reactComponents` — see the field-naming note in
`src/types.ts`).

Annotations serialize to markdown at one of four detail levels, picked from
the toolbar:

- **Compact** — comment + selector only. Good for small fixes.
- **Standard** — adds CSS classes and position. Balanced default.
- **Detailed** — adds nearby text and the full component chain.
- **Forensic** — adds computed styles, accessibility info, URL, timestamp.
  For debugging layout/style issues.

See `src/markdown.ts` for the exact field ordering per level.

## Project layout

```text
src/
  types.ts          annotation schema types
  dom.ts             framework-agnostic DOM helpers
  vueTree.ts         Vue component-tree + source-file detection
  markdown.ts        markdown serialization, 4 detail levels
  store.ts           shared reactive annotation store (no Pinia needed)
  TianAnnotate.vue   the toolbar component
  index.ts           public exports
demo/                minimal Vite + Vue app exercising the component
```

## Not implemented

- **Backend sync (API / webhooks / realtime push)** — out of scope here;
  this package only produces annotation data client-side. Point your own
  backend at the `annotations` array from `useTianAnnotateStore()` if you
  want to sync it elsewhere. The `AnnotationEvent` type in `src/types.ts`
  is provided for anyone wiring up that kind of sync layer.
- **Layout mode** (`kind: "placement" | "rearrange"`) — typed in
  `types.ts` for forward-compatibility, but the UI only creates `"feedback"`
  annotations.
- **Multi-select / drag-area selection** — single-element click only.
- **Animation pause** — not implemented.

## Build

```bash
npm install
npm run typecheck   # vue-tsc --noEmit
npm run build        # vite build -> dist/
```

## License

MIT.
