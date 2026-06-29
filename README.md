# tian-vue-annotate

Click-to-annotate visual feedback toolbar for Vue 3. Click any element on your running app, leave a comment, and let AI coding agents (Claude Code, OpenCode, Cursor) read and fix it automatically via MCP.

- **No backend required** for basic use — copy annotations as markdown and paste into any AI chat
- **With [`tian-vue-annotate-server`](https://github.com/fuze210699/tian-agentic-be)** — agents read annotations directly via MCP tools, dispatch fixes from the UI, real-time thread updates

## Install

```bash
npm install tian-vue-annotate
```

## Setup

### Vite (recommended)

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { tianAnnotate } from 'tian-vue-annotate/vite'

export default defineConfig({
  plugins: [vue(), tianAnnotate()],
})
```

```vue
<!-- App.vue -->
<script setup>
import { TianAnnotate } from 'tian-vue-annotate'
import 'tian-vue-annotate/style.css'
</script>

<template>
  <RouterView />
  <TianAnnotate sync-endpoint="/_tian-annotate" />
</template>
```

The Vite plugin embeds the API server directly into the dev server — no separate process needed.

---

### Webpack (webpack-dev-server v4+)

```js
// webpack.config.js
const { tianAnnotateMiddleware } = require('tian-vue-annotate/webpack')

module.exports = {
  // ...
  devServer: {
    setupMiddlewares: (middlewares, devServer) => {
      devServer.app.use(tianAnnotateMiddleware())
      return middlewares
    },
  },
}
```

```vue
<TianAnnotate sync-endpoint="/_tian-annotate" />
```

webpack-dev-server v3:

```js
devServer: {
  before: (app) => { app.use(tianAnnotateMiddleware()) }
}
```

---

### Standalone (any setup)

Run the companion server in your project root:

```bash
npx tian-vue-annotate-server server
# → HTTP API on http://localhost:4848
```

```vue
<TianAnnotate sync-endpoint="http://localhost:4848" />
```

---

## AI agent integration (MCP)

Run once in your project:

```bash
npx tian-vue-annotate-server init
```

This detects your AI agent (Claude Code or OpenCode) and writes `.mcp.json` so the agent has access to annotation tools. After this, the "Fix with Claude / Fix with OpenCode" buttons in the UI work end-to-end:

1. You click an element → leave a comment
2. Click **Fix with Claude** (or OpenCode)
3. The agent reads the annotation via MCP, locates the source file, applies the fix, and replies in the thread

---

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `syncEndpoint` | `string` | — | Base URL of the API server. Required for backend sync and dispatch |
| `syncSessionId` | `string` | — | Groups annotations per session |
| `defaultFormat` | `'compact' \| 'standard' \| 'detailed' \| 'forensic'` | `'standard'` | Default markdown detail level for copy |
| `enableLayoutMode` | `boolean` | `false` | Enable placement / wireframe / rearrange layout modes |
| `persistKey` | `string` | — | localStorage key for persisting annotations across reloads |
| `accentColor` | `string` | `'#6366f1'` | Accent color for outlines and buttons |
| `pauseAnimations` | `boolean` | `true` | Pause page animations when annotation mode is active |
| `blockInteractionOnCopy` | `boolean` | `false` | Briefly block page interaction after copying |
| `copyToClipboard` | `boolean` | `true` | When `false`, copy emits the `copy` event instead of writing clipboard |

## Emits

| Event | Payload | Description |
| --- | --- | --- |
| `annotation-add` | `Annotation` | New annotation created |
| `annotation-delete` | `string` (id) | Annotation deleted |
| `annotation-update` | `{ id, patch }` | Annotation updated |
| `annotations-clear` | — | All annotations cleared |
| `copy` | `string` (markdown) | Copy triggered (when `copyToClipboard` is false) |
| `session-created` | `string` (sessionId) | Sync session first established |

## Keyboard shortcuts

Active when annotation mode is on (except the toggle).

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+Shift+F` | Toggle annotation mode |
| `Esc` | Close popup / exit mode |
| `C` | Copy annotations as markdown |
| `H` | Show / hide pins |
| `P` | Pause / resume animations |
| `X` | Clear all annotations |
| `L` | Cycle layout mode (requires `enableLayoutMode`) |

## Annotation detail levels

| Level | What's included |
| --- | --- |
| `compact` | Comment + CSS selector |
| `standard` | + classes, position |
| `detailed` | + nearby text, Vue component chain |
| `forensic` | + computed styles, accessibility, URL, timestamp |

## License

[PolyForm Noncommercial 1.0.0](./LICENSE) — free for personal and open-source use.
