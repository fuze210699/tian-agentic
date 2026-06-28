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

## Props

| Prop                     | Type                                                  | Default      | Description                                                        |
| ------------------------ | ----------------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `defaultFormat`          | `'compact' \| 'standard' \| 'detailed' \| 'forensic'` | `'standard'` | Default markdown detail level                                      |
| `pauseAnimations`        | `boolean`                                             | `true`       | Pause page animations when annotation mode is active               |
| `persistKey`             | `string`                                              | —            | localStorage key for persisting annotations across reloads         |
| `enableLayoutMode`       | `boolean`                                             | `false`      | Enable placement/rearrange layout modes                            |
| `syncEndpoint`           | `string`                                              | —            | Base URL of a tian-agentic-be instance for backend sync            |
| `syncSessionId`          | `string`                                              | —            | Groups annotations server-side per session                         |
| `accentColor`            | `string`                                              | `'#6366f1'`  | Custom accent color for outlines, buttons, and pins                |
| `blockInteractionOnCopy` | `boolean`                                             | `false`      | Block page interaction briefly after copy                          |
| `copyToClipboard`        | `boolean`                                             | `true`       | When `false`, Copy emits `copy` event instead of writing clipboard |

## Emits

| Event               | Payload                                      | Description                                    |
| ------------------- | -------------------------------------------- | ---------------------------------------------- |
| `annotation-add`    | `Annotation`                                 | Fired when a new annotation is created         |
| `annotation-delete` | `string` (id)                                | Fired when an annotation is deleted            |
| `annotation-update` | `{ id: string, patch: Partial<Annotation> }` | Fired when an annotation is updated            |
| `annotations-clear` | —                                            | Fired when all annotations are cleared         |
| `copy`              | `string` (markdown)                          | Fired when Copy is triggered                   |
| `session-created`   | `string` (sessionId)                         | Fired when a sync session is first established |

## Keyboard shortcuts

Only active when the toolbar is active (except `Ctrl/Cmd+Shift+F`).

| Shortcut           | Action                                               |
| ------------------ | ---------------------------------------------------- |
| `Ctrl/Cmd+Shift+F` | Toggle annotation mode on/off                        |
| `Esc`              | Close popup/modal, or exit annotation mode           |
| `P`                | Pause/resume page animations                         |
| `H`                | Show/hide annotation pins                            |
| `C`                | Copy annotations as markdown                         |
| `X`                | Clear all annotations                                |
| `L`                | Cycle layout mode (feedback → placement → rearrange) |

Shortcuts are disabled when typing in input fields, textareas, or contenteditable elements.

## Annotation kinds

| Kind        | Description                                                     |
| ----------- | --------------------------------------------------------------- |
| `feedback`  | Standard annotation on an element or multi-select group         |
| `area`      | Annotation on a drag-selected empty region (no elements inside) |
| `placement` | Propose a new component at a location                           |
| `rearrange` | Propose moving an existing element                              |

## Build

```bash
npm install
npm run typecheck   # vue-tsc --noEmit
npm run build        # vite build -> dist/
```

## License

MIT.
