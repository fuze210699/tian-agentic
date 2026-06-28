<script setup lang="ts">
import { TianAnnotate } from '../src/index';
import type { Annotation } from '../src/types';

// Surface emits on `window` so Playwright can assert on them without needing
// clipboard permissions or other browser-API plumbing (Phase 6 E2E coverage).
declare global {
  interface Window {
    __tianEvents: { type: string; payload: unknown }[];
  }
}
window.__tianEvents = [];
function logEvent(type: string, payload: unknown) {
  window.__tianEvents.push({ type, payload });
}
function onAnnotationAdd(a: Annotation) {
  logEvent('annotation-add', a);
}
function onAnnotationDelete(id: string) {
  logEvent('annotation-delete', id);
}
function onAnnotationUpdate(p: { id: string; patch: Partial<Annotation> }) {
  logEvent('annotation-update', p);
}
function onAnnotationsClear() {
  logEvent('annotations-clear', null);
}
function onCopy(md: string) {
  logEvent('copy', md);
}
function onSessionCreated(id: string) {
  logEvent('session-created', id);
}
</script>

<template>
  <main class="dashboard">
    <h1 class="dashboard__title">Demo Dashboard</h1>
    <p>Click the <strong>+</strong> button bottom-right to start annotating.</p>

    <section class="demo-section">
      <h2>Elements to annotate</h2>
      <div class="card">
        <h3 class="card__title">Animated card</h3>
        <p class="card__text">This card has a CSS animation (pulse).</p>
        <button class="submit-btn">Submit</button>
      </div>
      <div class="card">
        <h3 class="card__title">Text content</h3>
        <p class="card__text">
          Select and annotate specific sentences like this one. The quick brown fox jumps over the
          lazy dog. Another paragraph for multi-select drag testing.
        </p>
        <span class="badge">Beta</span>
      </div>
      <div class="card">
        <h3 class="card__title">Interactive</h3>
        <input class="text-input" placeholder="Type something..." />
        <button class="outline-btn">Cancel</button>
        <button class="outline-btn">Save</button>
      </div>
      <div class="card">
        <h3 class="card__title">Shadow DOM (Phase 5)</h3>
        <p class="card__text">Button below lives inside an open shadow root.</p>
        <tian-demo-widget></tian-demo-widget>
      </div>
      <!-- Empty area on purpose, for Phase 4 (Area mode) drag-select testing -->
      <div class="empty-area"></div>
    </section>
  </main>

  <TianAnnotate
    default-format="standard"
    :pause-animations="true"
    persist-key="tian-annotate-demo"
    :enable-layout-mode="true"
    sync-endpoint="http://localhost:4848"
    sync-session-id="tian-annotate-demo"
    accent-color="#ef4444"
    :block-interaction-on-copy="true"
    :copy-to-clipboard="false"
    @annotation-add="onAnnotationAdd"
    @annotation-delete="onAnnotationDelete"
    @annotation-update="onAnnotationUpdate"
    @annotations-clear="onAnnotationsClear"
    @copy="onCopy"
    @session-created="onSessionCreated"
  />
</template>

<style>
@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(99, 102, 241, 0);
  }
}
body {
  margin: 0;
}
.dashboard {
  padding: 40px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  max-width: 720px;
}
.demo-section {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.card {
  padding: 16px;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  background: #fafafa;
}
.card:nth-child(1) {
  animation: pulse 2s infinite;
}
.card__title {
  margin: 0 0 6px 0;
  font-size: 16px;
}
.card__text {
  margin: 0 0 10px 0;
  font-size: 14px;
  line-height: 1.5;
  color: #3f3f46;
}
.submit-btn {
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  background: #18181b;
  color: #fff;
  cursor: pointer;
}
.outline-btn {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  background: #fff;
  cursor: pointer;
  margin-right: 6px;
}
.text-input {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  font-size: 14px;
  display: block;
  margin-bottom: 8px;
  width: 200px;
}
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  background: #6366f1;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}
.empty-area {
  height: 160px;
  border: 1px dashed #d4d4d8;
  border-radius: 10px;
}
</style>
