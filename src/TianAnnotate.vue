<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useTianAnnotateStore } from './store';
import {
  describeElement,
  getElementPath,
  getFullPath,
  getCssClasses,
  getBoundingBox,
  getComputedStylesSummary,
  getNearbyText,
  getAccessibilitySummary,
  isFixedOrSticky,
  getElementsInRect,
  getMeaningfulTarget,
  getUnionRect,
} from './dom';
import { getVueInstance, getComponentTree, getSourceFile } from './vueTree';
import { serializeAnnotations } from './markdown';
import type { Annotation, OutputFormat, Rect } from './types';

const props = withDefaults(
  defineProps<{
    defaultFormat?: OutputFormat;
    pauseAnimations?: boolean;
    persistKey?: string;
    enableLayoutMode?: boolean;
  }>(),
  { defaultFormat: 'standard', pauseAnimations: true, enableLayoutMode: false }
);

const {
  annotations,
  addAnnotation,
  removeAnnotation,
  clearAll,
  setStatus,
  addThreadMessage,
} = useTianAnnotateStore(props.persistKey);

const active = ref(false);
const hoverTarget = ref<Element | null>(null);
const precise = ref(false);
const mouseX = ref(0);
const mouseY = ref(0);
const format = ref<OutputFormat>(props.defaultFormat);
const copyState = ref<'idle' | 'copied'>('idle');
const mode = ref<'feedback' | 'placement' | 'rearrange'>('feedback');
const filterStatus = ref<'all' | 'pending' | 'acknowledged' | 'resolved'>('all');
const animationsPaused = ref(props.pauseAnimations);
const pinsVisible = ref(true);
const showSettings = ref(false);

const pendingPick = reactive<{
  el: Element | null;
  x: number;
  y: number;
  comment: string;
  intent: Annotation['intent'] | '';
  severity: Annotation['severity'] | '';
  selectedText: string;
  isMultiSelect: boolean;
  nearbyElements: string;
  componentType: string;
  placementWidth: number;
  placementHeight: number;
  placementText: string;
  rearrangeLabel: string;
  rearrangeSelector: string;
  rearrangeTagName: string;
  rearrangeOriginalRect: Rect | null;
  rearrangeCurrentRect: Rect | null;
  rearrangeIsFixed: boolean;
}>({
  el: null,
  x: 0,
  y: 0,
  comment: '',
  intent: '',
  severity: '',
  selectedText: '',
  isMultiSelect: false,
  nearbyElements: '',
  componentType: '',
  placementWidth: 100,
  placementHeight: 40,
  placementText: '',
  rearrangeLabel: '',
  rearrangeSelector: '',
  rearrangeTagName: '',
  rearrangeOriginalRect: null,
  rearrangeCurrentRect: null,
  rearrangeIsFixed: false,
});

const selectedAnnotation = ref<Annotation | null>(null);
const threadMessage = ref('');
const threadRole = ref<'human' | 'agent'>('human');

const dragStart = ref<{ x: number; y: number } | null>(null);
const dragRect = ref<Rect | null>(null);
const dragEl = ref<Element | null>(null);
const rearrangeClone = ref<{ el: Element; x: number; y: number } | null>(null);
const wasDragging = ref(false);
const multiSelectGroupRect = ref<Rect | null>(null);

let lastHighlighted: Element | null = null;
let animStyle: HTMLStyleElement | null = null;
const DRAG_THRESHOLD = 5;
const DRAG_MIN_SIZE = 10;

// ---- animation pause ----
function injectAnimPause() {
  if (animStyle) return;
  animStyle = document.createElement('style');
  animStyle.textContent =
    ':not(.tian-annotate-ignore):not(.tian-annotate-ignore *){animation-play-state:paused!important;transition:none!important}';
  document.head.appendChild(animStyle);
}
function removeAnimPause() {
  if (!animStyle) return;
  animStyle.remove();
  animStyle = null;
}

watch(active, (val) => {
  if (val && animationsPaused.value) injectAnimPause();
  else removeAnimPause();
  if (!val) {
    dragStart.value = null;
    dragRect.value = null;
    dragEl.value = null;
    rearrangeClone.value = null;
    wasDragging.value = false;
    showSettings.value = false;
  }
});

function toggleAnimationsPaused() {
  animationsPaused.value = !animationsPaused.value;
  if (active.value) {
    if (animationsPaused.value) injectAnimPause();
    else removeAnimPause();
  }
}

function togglePinsVisible() {
  pinsVisible.value = !pinsVisible.value;
}

function toggleSettings() {
  showSettings.value = !showSettings.value;
}

// ---- ignored checks ----
function isIgnored(target: EventTarget | null): boolean {
  return !!(target instanceof Element && target.closest('.tian-annotate-ignore'));
}

function clearHighlight() {
  lastHighlighted?.classList.remove('tian-annotate-hover-outline');
  lastHighlighted = null;
  hoverTarget.value = null;
}

function clearMultiSelectHighlight() {
  multiSelectGroupRect.value = null;
}

// ---- event handlers ----
function onMouseDown(e: MouseEvent) {
  if (!active.value || isIgnored(e.target)) return;
  const target = e.target as Element;

  if (mode.value === 'rearrange') {
    e.preventDefault();
    const el = getMeaningfulTarget(target, { precise: e.altKey });
    if (el && el !== document.body && el !== document.documentElement) {
      dragStart.value = { x: e.clientX, y: e.clientY };
      dragEl.value = el;
      rearrangeClone.value = { el, x: e.clientX, y: e.clientY };
      wasDragging.value = false;
    }
    return;
  }

  if (mode.value === 'feedback') {
    dragStart.value = { x: e.clientX, y: e.clientY };
    wasDragging.value = false;
  }
}

function onMouseMove(e: MouseEvent) {
  mouseX.value = e.clientX;
  mouseY.value = e.clientY;

  if (!active.value) return;

  if (dragStart.value && dragEl.value && mode.value === 'rearrange') {
    const dx = e.clientX - dragStart.value.x;
    const dy = e.clientY - dragStart.value.y;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      wasDragging.value = true;
      rearrangeClone.value = { el: dragEl.value, x: e.clientX, y: e.clientY };
    }
    return;
  }

  if (dragStart.value && !dragEl.value && mode.value === 'feedback') {
    const dx = e.clientX - dragStart.value.x;
    const dy = e.clientY - dragStart.value.y;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      // The few pixels of movement before this threshold fires still ran the
      // normal single-element hover-highlight below (it only returns once
      // wasDragging is true) — clear that stray outline now that we know
      // this is a drag-select, not a single click.
      clearHighlight();
      wasDragging.value = true;
      const left = Math.min(dragStart.value.x, e.clientX);
      const top = Math.min(dragStart.value.y, e.clientY);
      dragRect.value = {
        x: left + window.scrollX,
        y: top + window.scrollY,
        width: Math.abs(dx),
        height: Math.abs(dy),
      };
      return;
    }
  }

  if (pendingPick.el || selectedAnnotation.value) return;
  const rawTarget = e.target as Element;
  if (isIgnored(rawTarget)) {
    clearHighlight();
    return;
  }
  precise.value = e.altKey;
  const target = getMeaningfulTarget(rawTarget, { precise: e.altKey });
  if (target === lastHighlighted) return;
  clearHighlight();
  target.classList.add('tian-annotate-hover-outline');
  lastHighlighted = target;
  hoverTarget.value = target;
}

function onMouseUp(e: MouseEvent) {
  if (!active.value) return;

  if (dragRect.value && wasDragging.value && dragRect.value.width >= DRAG_MIN_SIZE && dragRect.value.height >= DRAG_MIN_SIZE) {
    const rect = dragRect.value;
    const left = rect.x - window.scrollX;
    const top = rect.y - window.scrollY;
    const els = getElementsInRect({ left, top, width: rect.width, height: rect.height });
    if (els.length) {
      const descriptions = els.map((el) => describeElement(el)).slice(0, 10);
      const outer = els[0];
      multiSelectGroupRect.value = getUnionRect(els);
      pendingPick.el = outer;
      pendingPick.x = Math.min(e.clientX, window.innerWidth - 260);
      pendingPick.y = Math.min(e.clientY, window.innerHeight - 220);
      pendingPick.comment = '';
      pendingPick.intent = '';
      pendingPick.severity = '';
      pendingPick.selectedText = '';
      pendingPick.isMultiSelect = true;
      pendingPick.nearbyElements = descriptions.join(', ');
      pendingPick.componentType = '';
      pendingPick.placementWidth = 100;
      pendingPick.placementHeight = 40;
      pendingPick.placementText = '';
      pendingPick.rearrangeLabel = '';
      pendingPick.rearrangeSelector = '';
      pendingPick.rearrangeTagName = '';
      pendingPick.rearrangeOriginalRect = null;
      pendingPick.rearrangeCurrentRect = null;
      pendingPick.rearrangeIsFixed = false;
    }
    dragStart.value = null;
    dragRect.value = null;
    return;
  }

  if (rearrangeClone.value && wasDragging.value && dragEl.value) {
    const el = dragEl.value;
    const fixed = isFixedOrSticky(el);
    const origBox = getBoundingBox(el);
    // originalRect is in document coordinates (getBoundingBox already adds
    // scrollX/scrollY unless the element is fixed/sticky). clientX/clientY
    // are viewport coordinates, so the same offset must be added here too —
    // otherwise originalRect and currentRect end up in different coordinate
    // spaces as soon as the page has scrolled.
    const cloneBox: Rect = {
      x: Math.round(e.clientX - origBox.width / 2 + (fixed ? 0 : window.scrollX)),
      y: Math.round(e.clientY - origBox.height / 2 + (fixed ? 0 : window.scrollY)),
      width: origBox.width,
      height: origBox.height,
    };
    pendingPick.el = el;
    pendingPick.x = Math.min(e.clientX, window.innerWidth - 260);
    pendingPick.y = Math.min(e.clientY, window.innerHeight - 220);
    pendingPick.comment = '';
    pendingPick.intent = '';
    pendingPick.severity = '';
    pendingPick.selectedText = '';
    pendingPick.isMultiSelect = false;
    pendingPick.nearbyElements = '';
    pendingPick.componentType = '';
    pendingPick.placementWidth = 100;
    pendingPick.placementHeight = 40;
    pendingPick.placementText = '';
    pendingPick.rearrangeLabel = describeElement(el);
    pendingPick.rearrangeSelector = getFullPath(el);
    pendingPick.rearrangeTagName = el.tagName.toLowerCase();
    pendingPick.rearrangeOriginalRect = origBox;
    pendingPick.rearrangeCurrentRect = cloneBox;
    pendingPick.rearrangeIsFixed = fixed;
    dragStart.value = null;
    dragEl.value = null;
    rearrangeClone.value = null;
    return;
  }

  dragStart.value = null;
  dragRect.value = null;
  dragEl.value = null;
  rearrangeClone.value = null;
}

function onClick(e: MouseEvent) {
  if (!active.value || isIgnored(e.target) || pendingPick.el || selectedAnnotation.value) return;
  if (wasDragging.value) {
    wasDragging.value = false;
    return;
  }

  if (mode.value === 'placement') {
    e.preventDefault();
    e.stopPropagation();
    pendingPick.el = getMeaningfulTarget(e.target as Element, { precise: e.altKey });
    pendingPick.x = Math.min(e.clientX, window.innerWidth - 260);
    pendingPick.y = Math.min(e.clientY, window.innerHeight - 280);
    pendingPick.comment = '';
    pendingPick.intent = '';
    pendingPick.severity = '';
    pendingPick.selectedText = '';
    pendingPick.isMultiSelect = false;
    pendingPick.nearbyElements = '';
    pendingPick.componentType = '';
    pendingPick.placementWidth = 100;
    pendingPick.placementHeight = 40;
    pendingPick.placementText = '';
    pendingPick.rearrangeLabel = '';
    pendingPick.rearrangeSelector = '';
    pendingPick.rearrangeTagName = '';
    pendingPick.rearrangeOriginalRect = null;
    pendingPick.rearrangeCurrentRect = null;
    pendingPick.rearrangeIsFixed = false;
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  pendingPick.el = getMeaningfulTarget(e.target as Element, { precise: e.altKey });
  pendingPick.x = Math.min(e.clientX, window.innerWidth - 260);
  pendingPick.y = Math.min(e.clientY, window.innerHeight - 220);
  pendingPick.comment = '';
  pendingPick.intent = '';
  pendingPick.severity = '';

  const sel = window.getSelection();
  if (sel && sel.toString().trim()) {
    pendingPick.selectedText = sel.toString().trim();
    let container: Node | null = sel.anchorNode || sel.focusNode;
    if (container) {
      while (container && container.nodeType !== 1) container = container.parentNode as Node;
      if (container instanceof Element) pendingPick.el = container;
    }
  } else {
    pendingPick.selectedText = '';
  }
  pendingPick.isMultiSelect = false;
  pendingPick.nearbyElements = '';
  pendingPick.componentType = '';
  pendingPick.placementWidth = 100;
  pendingPick.placementHeight = 40;
  pendingPick.placementText = '';
  pendingPick.rearrangeLabel = '';
  pendingPick.rearrangeSelector = '';
  pendingPick.rearrangeTagName = '';
  pendingPick.rearrangeOriginalRect = null;
  pendingPick.rearrangeCurrentRect = null;
  pendingPick.rearrangeIsFixed = false;
}

function toggleActive() {
  active.value = !active.value;
  if (!active.value) {
    clearHighlight();
    clearMultiSelectHighlight();
    pendingPick.el = null;
    selectedAnnotation.value = null;
  }
}

function cancelPick() {
  pendingPick.el = null;
  clearHighlight();
  clearMultiSelectHighlight();
  wasDragging.value = false;
}

function confirmPick() {
  const el = pendingPick.el;
  clearMultiSelectHighlight();

  if (mode.value === 'placement') {
    if (!pendingPick.comment.trim() || !pendingPick.componentType.trim()) return;
    const box = el ? getBoundingBox(el) : { x: pendingPick.x, y: pendingPick.y, width: 1, height: 1 };
    addAnnotation({
      kind: 'placement',
      comment: pendingPick.comment.trim(),
      elementPath: el ? getElementPath(el) : 'body',
      element: 'div',
      x: Math.round((box.x / Math.max(document.documentElement.scrollWidth, 1)) * 1000) / 10,
      y: box.y,
      url: window.location.href,
      boundingBox: box,
      intent: pendingPick.intent || undefined,
      severity: pendingPick.severity || undefined,
      placement: {
        componentType: pendingPick.componentType.trim(),
        width: pendingPick.placementWidth,
        height: pendingPick.placementHeight,
        scrollY: Math.round(window.scrollY),
        text: pendingPick.placementText.trim() || undefined,
      },
    });
    pendingPick.el = null;
    clearHighlight();
    return;
  }

  if (mode.value === 'rearrange' && pendingPick.rearrangeOriginalRect && pendingPick.rearrangeCurrentRect) {
    if (!pendingPick.comment.trim()) return;
    const rearrangeWidthBasis = pendingPick.rearrangeIsFixed
      ? window.innerWidth
      : document.documentElement.scrollWidth;
    addAnnotation({
      kind: 'rearrange',
      comment: pendingPick.comment.trim(),
      elementPath: pendingPick.rearrangeSelector,
      element: pendingPick.rearrangeTagName,
      x: Math.round((pendingPick.rearrangeCurrentRect.x / Math.max(rearrangeWidthBasis, 1)) * 1000) / 10,
      y: pendingPick.rearrangeCurrentRect.y,
      url: window.location.href,
      boundingBox: pendingPick.rearrangeCurrentRect,
      isFixed: pendingPick.rearrangeIsFixed,
      intent: pendingPick.intent || undefined,
      severity: pendingPick.severity || undefined,
      rearrange: {
        selector: pendingPick.rearrangeSelector,
        label: pendingPick.rearrangeLabel,
        tagName: pendingPick.rearrangeTagName,
        originalRect: pendingPick.rearrangeOriginalRect,
        currentRect: pendingPick.rearrangeCurrentRect,
      },
    });
    pendingPick.el = null;
    clearHighlight();
    return;
  }

  if (!el || !pendingPick.comment.trim()) return;

  const instance = getVueInstance(el);
  const componentTree = instance ? getComponentTree(instance, format.value === 'detailed') : undefined;
  const sourceFile = instance ? getSourceFile(instance) : undefined;
  const box = getBoundingBox(el);
  const fixed = isFixedOrSticky(el);
  const widthBasis = fixed ? window.innerWidth : document.documentElement.scrollWidth;

  addAnnotation({
    comment: pendingPick.comment.trim(),
    elementPath: getElementPath(el),
    fullPath: getFullPath(el),
    element: el.tagName.toLowerCase(),
    x: Math.round((box.x / Math.max(widthBasis, 1)) * 1000) / 10,
    y: box.y,
    url: window.location.href,
    boundingBox: box,
    cssClasses: getCssClasses(el),
    computedStyles: getComputedStylesSummary(el),
    accessibility: getAccessibilitySummary(el),
    nearbyText: pendingPick.isMultiSelect ? undefined : getNearbyText(el),
    isFixed: fixed,
    isMultiSelect: pendingPick.isMultiSelect || undefined,
    nearbyElements: pendingPick.isMultiSelect ? pendingPick.nearbyElements : undefined,
    reactComponents: componentTree || undefined,
    selectedText: pendingPick.selectedText || undefined,
    intent: pendingPick.intent || undefined,
    severity: pendingPick.severity || undefined,
  });

  if (sourceFile) console.debug('[tian-annotate-vue] source:', sourceFile);

  pendingPick.el = null;
  clearHighlight();
  wasDragging.value = false;
}

function pinStyle(a: Annotation) {
  return { position: a.isFixed ? 'fixed' : 'absolute', left: `${a.x}%`, top: `${a.y}px` } as const;
}

function pinClass(a: Annotation) {
  if (a.kind === 'placement') return 'tian-annotate-pin tian-annotate-pin--placement';
  if (a.kind === 'rearrange') return 'tian-annotate-pin tian-annotate-pin--rearrange';
  return `tian-annotate-pin tian-annotate-pin--${a.status || 'pending'}`;
}

async function copyMarkdown() {
  const md = serializeAnnotations(filteredAnnotations.value, format.value);
  await navigator.clipboard.writeText(md);
  copyState.value = 'copied';
  setTimeout(() => (copyState.value = 'idle'), 1500);
}

function selectAnnotation(a: Annotation) {
  selectedAnnotation.value = a;
  threadMessage.value = '';
  threadRole.value = 'human';
}

function closeDetail() {
  selectedAnnotation.value = null;
}

function submitThreadMessage() {
  if (!selectedAnnotation.value || !threadMessage.value.trim()) return;
  addThreadMessage(selectedAnnotation.value.id, {
    role: threadRole.value,
    content: threadMessage.value.trim(),
  });
  threadMessage.value = '';
  const updated = annotations.find((a) => a.id === selectedAnnotation.value!.id);
  if (updated) selectedAnnotation.value = updated;
}

function markStatus(id: string, status: Annotation['status']) {
  setStatus(id, status);
  const updated = annotations.find((a) => a.id === id);
  if (updated) selectedAnnotation.value = updated;
}

function deleteAnnotation(id: string) {
  removeAnnotation(id);
  selectedAnnotation.value = null;
}

const filteredAnnotations = computed(() => {
  if (filterStatus.value === 'all') return annotations;
  return annotations.filter((a) => a.status === filterStatus.value);
});

const dragOverlayStyle = computed(() => {
  if (!dragRect.value) return {};
  const sx = window.scrollX;
  const sy = window.scrollY;
  return {
    left: dragRect.value.x - sx + 'px',
    top: dragRect.value.y - sy + 'px',
    width: dragRect.value.width + 'px',
    height: dragRect.value.height + 'px',
  };
});

const multiSelectGroupOverlayStyle = computed(() => {
  if (!multiSelectGroupRect.value) return {};
  const sx = window.scrollX;
  const sy = window.scrollY;
  return {
    left: multiSelectGroupRect.value.x - sx + 'px',
    top: multiSelectGroupRect.value.y - sy + 'px',
    width: multiSelectGroupRect.value.width + 'px',
    height: multiSelectGroupRect.value.height + 'px',
  };
});

const annotationCountLabel = computed(
  () => `${filteredAnnotations.value.length}/${annotations.length} annotation${annotations.length === 1 ? '' : 's'}`
);

onMounted(() => {
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('click', onClick, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onMouseDown, true);
  window.removeEventListener('mousemove', onMouseMove, true);
  window.removeEventListener('mouseup', onMouseUp, true);
  window.removeEventListener('click', onClick, true);
  clearHighlight();
  clearMultiSelectHighlight();
  removeAnimPause();
});
</script>

<template>
  <div class="tian-annotate-toolbar tian-annotate-ignore">
    <!-- Settings popover (format level, layout mode, status filter) -->
    <div v-if="active && showSettings" class="tian-annotate-panel">
      <div class="tian-annotate-panel-row">
        <span>{{ annotationCountLabel }}</span>
        <select v-model="format">
          <option value="compact">Compact</option>
          <option value="standard">Standard</option>
          <option value="detailed">Detailed</option>
          <option value="forensic">Forensic</option>
        </select>
      </div>
      <div v-if="props.enableLayoutMode" class="tian-annotate-panel-row">
        <select v-model="mode">
          <option value="feedback">Feedback</option>
          <option value="placement">Placement</option>
          <option value="rearrange">Rearrange</option>
        </select>
      </div>
      <div class="tian-annotate-panel-row">
        <select v-model="filterStatus">
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>
    </div>

    <!-- Inactive: round "+" toggle -->
    <button
      v-if="!active"
      type="button"
      class="tian-annotate-toggle"
      aria-label="Start annotating"
      @click="toggleActive"
    >
      <span>+</span>
    </button>

    <!-- Active: pill icon bar -->
    <div v-else class="tian-annotate-icon-bar">
      <button
        type="button"
        class="tian-annotate-icon-btn"
        :class="{ 'is-on': animationsPaused }"
        :aria-pressed="animationsPaused"
        :aria-label="animationsPaused ? 'Resume animations' : 'Pause animations'"
        :title="animationsPaused ? 'Resume animations' : 'Pause animations'"
        @click="toggleAnimationsPaused"
      >
        <svg v-if="!animationsPaused" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
        <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>

      <button
        type="button"
        class="tian-annotate-icon-btn"
        :class="{ 'is-on': !pinsVisible }"
        :aria-pressed="!pinsVisible"
        :aria-label="pinsVisible ? 'Hide pins' : 'Show pins'"
        :title="pinsVisible ? 'Hide pins' : 'Show pins'"
        @click="togglePinsVisible"
      >
        <svg v-if="pinsVisible" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0112 19c-7 0-11-7-11-7a18.5 18.5 0 015.06-5.94M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 7 11 7a18.5 18.5 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
      </button>

      <span class="tian-annotate-icon-divider" />

      <button
        type="button"
        class="tian-annotate-icon-btn"
        :disabled="!filteredAnnotations.length"
        aria-label="Copy markdown"
        :title="copyState === 'copied' ? 'Copied!' : 'Copy markdown'"
        @click="copyMarkdown"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      </button>

      <button
        type="button"
        class="tian-annotate-icon-btn"
        :disabled="!annotations.length"
        aria-label="Clear all annotations"
        title="Clear all annotations"
        @click="clearAll"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
      </button>

      <span class="tian-annotate-icon-divider" />

      <button
        type="button"
        class="tian-annotate-icon-btn"
        :class="{ 'is-on': showSettings }"
        :aria-pressed="showSettings"
        aria-label="Settings"
        title="Settings"
        @click="toggleSettings"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0A1.65 1.65 0 009.5 4.09V4a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82h0c.27.63.85 1.07 1.51 1.07H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
      </button>

      <button
        type="button"
        class="tian-annotate-icon-btn"
        aria-label="Exit annotation mode"
        title="Exit annotation mode"
        @click="toggleActive"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </div>

  <div
    v-if="active && hoverTarget && !pendingPick.el && !selectedAnnotation"
    class="tian-annotate-tag tian-annotate-ignore"
    :style="{ left: mouseX + 14 + 'px', top: mouseY + 14 + 'px' }"
  >
    {{ mode === 'placement' ? 'Click to place' : mode === 'rearrange' ? 'Drag to move' : describeElement(hoverTarget) }}
    <span v-if="precise" class="tian-annotate-tag-hint"> · precise (Alt)</span>
  </div>

  <!-- drag selection overlay (while still dragging) -->
  <div
    v-if="dragRect"
    class="tian-annotate-drag-overlay tian-annotate-ignore"
    :style="dragOverlayStyle"
  />

  <!-- multi-select group highlight (one box around the whole group, not one per element) -->
  <div
    v-if="multiSelectGroupRect"
    class="tian-annotate-multiselect-overlay tian-annotate-ignore"
    :style="multiSelectGroupOverlayStyle"
  />

  <!-- rearrange clone overlay -->
  <div
    v-if="rearrangeClone"
    class="tian-annotate-rearrange-clone tian-annotate-ignore"
    :style="{
      left: rearrangeClone.x + 'px',
      top: rearrangeClone.y + 'px',
    }"
  >
    {{ describeElement(rearrangeClone.el) }}
  </div>

  <!-- Feedback popup -->
  <div
    v-if="pendingPick.el && mode === 'feedback'"
    class="tian-annotate-popup tian-annotate-ignore"
    :style="{ left: pendingPick.x + 'px', top: pendingPick.y + 'px' }"
  >
    <div v-if="pendingPick.isMultiSelect" class="tian-annotate-popup-title">Multi-select ({{ pendingPick.nearbyElements.split(', ').length }} elements)</div>
    <div v-else class="tian-annotate-popup-title">{{ pendingPick.selectedText ? `Selected: "${pendingPick.selectedText.slice(0, 40)}${pendingPick.selectedText.length > 40 ? '…' : ''}"` : describeElement(pendingPick.el) }}</div>
    <textarea
      v-model="pendingPick.comment"
      rows="2"
      placeholder="What's wrong, or what should change?"
      autofocus
    />
    <div class="tian-annotate-popup-row">
      <select v-model="pendingPick.intent">
        <option value="">Intent…</option>
        <option value="fix">Fix</option>
        <option value="change">Change</option>
        <option value="question">Question</option>
        <option value="approve">Approve</option>
      </select>
      <select v-model="pendingPick.severity">
        <option value="">Severity…</option>
        <option value="blocking">Blocking</option>
        <option value="important">Important</option>
        <option value="suggestion">Suggestion</option>
      </select>
    </div>
    <div class="tian-annotate-popup-row">
      <button type="button" class="tian-annotate-btn-ghost" @click="cancelPick">Cancel</button>
      <button type="button" :disabled="!pendingPick.comment.trim()" @click="confirmPick">Add</button>
    </div>
  </div>

  <!-- Placement popup -->
  <div
    v-if="pendingPick.el && mode === 'placement'"
    class="tian-annotate-popup tian-annotate-ignore"
    :style="{ left: pendingPick.x + 'px', top: pendingPick.y + 'px' }"
  >
    <div class="tian-annotate-popup-title">Place a new component</div>
    <input
      v-model="pendingPick.componentType"
      class="tian-annotate-input"
      placeholder="Component type (e.g. Button, Card)"
      autofocus
    />
    <div class="tian-annotate-popup-row">
      <input v-model.number="pendingPick.placementWidth" class="tian-annotate-input" type="number" placeholder="Width" />
      <input v-model.number="pendingPick.placementHeight" class="tian-annotate-input" type="number" placeholder="Height" />
    </div>
    <input
      v-model="pendingPick.placementText"
      class="tian-annotate-input"
      placeholder="Suggested text (optional)"
    />
    <div class="tian-annotate-popup-row">
      <label style="font-size:11px;color:inherit;align-self:center">Scroll Y: {{ Math.round(pendingPick.y) }}px</label>
    </div>
    <textarea
      v-model="pendingPick.comment"
      rows="2"
      placeholder="Why place it here?"
    />
    <div class="tian-annotate-popup-row">
      <select v-model="pendingPick.intent">
        <option value="">Intent…</option>
        <option value="fix">Fix</option>
        <option value="change">Change</option>
        <option value="question">Question</option>
        <option value="approve">Approve</option>
      </select>
      <select v-model="pendingPick.severity">
        <option value="">Severity…</option>
        <option value="blocking">Blocking</option>
        <option value="important">Important</option>
        <option value="suggestion">Suggestion</option>
      </select>
    </div>
    <div class="tian-annotate-popup-row">
      <button type="button" class="tian-annotate-btn-ghost" @click="cancelPick">Cancel</button>
      <button type="button" :disabled="!pendingPick.comment.trim() || !pendingPick.componentType.trim()" @click="confirmPick">Add</button>
    </div>
  </div>

  <!-- Rearrange popup -->
  <div
    v-if="pendingPick.el && mode === 'rearrange' && pendingPick.rearrangeOriginalRect"
    class="tian-annotate-popup tian-annotate-ignore"
    :style="{ left: pendingPick.x + 'px', top: pendingPick.y + 'px' }"
  >
    <div class="tian-annotate-popup-title">Move: {{ pendingPick.rearrangeLabel }}</div>
    <div style="font-size:11px;margin-bottom:6px;">
      From {{ pendingPick.rearrangeOriginalRect.x }},{{ pendingPick.rearrangeOriginalRect.y }} → {{ pendingPick.rearrangeCurrentRect?.x }},{{ pendingPick.rearrangeCurrentRect?.y }}
    </div>
    <textarea
      v-model="pendingPick.comment"
      rows="2"
      placeholder="Why move this?"
      autofocus
    />
    <div class="tian-annotate-popup-row">
      <select v-model="pendingPick.intent">
        <option value="">Intent…</option>
        <option value="fix">Fix</option>
        <option value="change">Change</option>
        <option value="question">Question</option>
        <option value="approve">Approve</option>
      </select>
      <select v-model="pendingPick.severity">
        <option value="">Severity…</option>
        <option value="blocking">Blocking</option>
        <option value="important">Important</option>
        <option value="suggestion">Suggestion</option>
      </select>
    </div>
    <div class="tian-annotate-popup-row">
      <button type="button" class="tian-annotate-btn-ghost" @click="cancelPick">Cancel</button>
      <button type="button" :disabled="!pendingPick.comment.trim()" @click="confirmPick">Add</button>
    </div>
  </div>

  <!-- Detail popup (view/edit annotation) -->
  <Teleport to="body">
    <div
      v-if="selectedAnnotation"
      class="tian-annotate-detail-overlay tian-annotate-ignore"
      @click.self="closeDetail"
    >
      <div class="tian-annotate-detail tian-annotate-ignore">
        <div class="tian-annotate-detail-header">
          <span>Annotation {{ annotations.findIndex(a => a.id === selectedAnnotation!.id) + 1 }}</span>
          <button type="button" class="tian-annotate-btn-ghost" @click="closeDetail">&times;</button>
        </div>

        <div class="tian-annotate-detail-field">
          <strong>Element:</strong> {{ selectedAnnotation.element }}
        </div>
        <div class="tian-annotate-detail-field">
          <strong>Status:</strong>
          <span :class="`tian-annotate-status tian-annotate-status--${selectedAnnotation.status}`">{{ selectedAnnotation.status }}</span>
        </div>
        <div class="tian-annotate-detail-field">
          <strong>Comment:</strong> {{ selectedAnnotation.comment }}
        </div>
        <div v-if="selectedAnnotation.selectedText" class="tian-annotate-detail-field">
          <strong>Selected text:</strong> "{{ selectedAnnotation.selectedText }}"
        </div>
        <div v-if="selectedAnnotation.intent" class="tian-annotate-detail-field">
          <strong>Intent:</strong> {{ selectedAnnotation.intent }}
        </div>
        <div v-if="selectedAnnotation.severity" class="tian-annotate-detail-field">
          <strong>Severity:</strong> {{ selectedAnnotation.severity }}
        </div>

        <!-- Thread -->
        <div class="tian-annotate-detail-section">
          <strong>Thread</strong>
          <div v-if="selectedAnnotation.thread?.length" class="tian-annotate-thread-messages">
            <div
              v-for="msg in selectedAnnotation.thread"
              :key="msg.id"
              class="tian-annotate-thread-msg"
              :class="`tian-annotate-thread-msg--${msg.role}`"
            >
              <span class="tian-annotate-thread-role">{{ msg.role }}</span>
              <span class="tian-annotate-thread-content">{{ msg.content }}</span>
            </div>
          </div>
          <div class="tian-annotate-thread-input-row">
            <select v-model="threadRole" class="tian-annotate-thread-role-select">
              <option value="human">Human</option>
              <option value="agent">Agent</option>
            </select>
            <input
              v-model="threadMessage"
              class="tian-annotate-input"
              placeholder="Add message..."
              @keydown.enter="submitThreadMessage"
            />
            <button type="button" class="tian-annotate-btn-sm" @click="submitThreadMessage" :disabled="!threadMessage.trim()">Send</button>
          </div>
        </div>

        <!-- Actions -->
        <div class="tian-annotate-detail-actions">
          <button
            v-if="selectedAnnotation.status !== 'acknowledged' && selectedAnnotation.status !== 'resolved' && selectedAnnotation.status !== 'dismissed'"
            type="button"
            class="tian-annotate-btn-status tian-annotate-btn--acknowledge"
            @click="markStatus(selectedAnnotation.id, 'acknowledged')"
          >Mark acknowledged</button>
          <button
            v-if="selectedAnnotation.status !== 'resolved'"
            type="button"
            class="tian-annotate-btn-status tian-annotate-btn--resolve"
            @click="markStatus(selectedAnnotation.id, 'resolved')"
          >Mark resolved</button>
          <button type="button" class="tian-annotate-btn-status tian-annotate-btn--delete" @click="deleteAnnotation(selectedAnnotation.id)">Delete</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Pins -->
  <Teleport to="body">
    <template v-if="pinsVisible">
      <div
        v-for="(a, i) in filteredAnnotations"
        :key="a.id"
        :class="pinClass(a)"
        :style="pinStyle(a)"
        :title="`#${i + 1}: ${a.comment}`"
        @click.stop="selectAnnotation(a)"
      >
        <template v-if="a.kind === 'placement'">+</template>
        <template v-else-if="a.kind === 'rearrange'">↕</template>
        <template v-else>{{ i + 1 }}</template>
      </div>
    </template>
  </Teleport>
</template>

<style>
.tian-annotate-hover-outline {
  outline: 2px solid #6366f1 !important;
  outline-offset: 1px !important;
  cursor: crosshair !important;
  transition: outline-color 80ms ease-out;
}

.tian-annotate-tag-hint {
  opacity: 0.6;
  font-style: italic;
}

.tian-annotate-toolbar {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 999999;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.tian-annotate-toggle {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: #18181b;
  color: #fff;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}

.tian-annotate-icon-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  background: rgba(24, 24, 27, 0.92);
  border-radius: 999px;
  padding: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(6px);
}
.tian-annotate-icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: #d4d4d8;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.tian-annotate-icon-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.tian-annotate-icon-btn.is-on {
  background: #6366f1;
  color: #fff;
}
.tian-annotate-icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.tian-annotate-icon-divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.18);
  margin: 0 2px;
}

.tian-annotate-panel {
  background: #fff;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  color: #18181b;
  min-width: 240px;
}
@media (prefers-color-scheme: dark) {
  .tian-annotate-panel {
    background: #18181b;
    color: #fafafa;
    border-color: #3f3f46;
  }
}
.tian-annotate-panel-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.tian-annotate-panel-row:last-child {
  margin-bottom: 0;
}
.tian-annotate-panel button,
.tian-annotate-panel select {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  background: #fff;
  cursor: pointer;
}
.tian-annotate-btn-ghost {
  background: transparent !important;
}

.tian-annotate-pin {
  position: absolute;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #6366f1;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 999998;
  transform: translate(-50%, -50%);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}
.tian-annotate-pin--acknowledged { background: #f59e0b; }
.tian-annotate-pin--resolved { background: #6b7280; opacity: 0.6; }
.tian-annotate-pin--placement { background: #10b981; border-radius: 4px; font-size: 16px; width: 24px; height: 24px; }
.tian-annotate-pin--rearrange { background: #8b5cf6; border-radius: 4px; font-size: 14px; width: 24px; height: 24px; }

.tian-annotate-tag {
  position: fixed;
  z-index: 999999;
  background: #18181b;
  color: #fff;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  padding: 3px 6px;
  border-radius: 4px;
  pointer-events: none;
}

.tian-annotate-popup {
  position: fixed;
  z-index: 1000000;
  width: 240px;
  background: #fff;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  padding: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
  color: #18181b;
}
@media (prefers-color-scheme: dark) {
  .tian-annotate-popup,
  .tian-annotate-detail {
    background: #18181b;
    color: #fafafa;
    border-color: #3f3f46;
  }
}
.tian-annotate-popup-title {
  font-weight: 600;
  margin-bottom: 6px;
  font-family: ui-monospace, monospace;
}
.tian-annotate-popup textarea {
  width: 100%;
  resize: vertical;
  margin-bottom: 6px;
  font-size: 12px;
  padding: 6px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  font-family: inherit;
  color: inherit;
  background: transparent;
}
.tian-annotate-popup-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.tian-annotate-popup-row:last-child {
  margin-bottom: 0;
}
.tian-annotate-popup select {
  flex: 1;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  background: transparent;
  color: inherit;
}
.tian-annotate-popup button {
  flex: 1;
  padding: 6px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  background: #6366f1;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
}
.tian-annotate-popup button.tian-annotate-btn-ghost {
  background: transparent;
  color: inherit;
}
.tian-annotate-popup button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tian-annotate-input {
  width: 100%;
  padding: 6px;
  margin-bottom: 6px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  font-size: 12px;
  font-family: inherit;
  color: inherit;
  background: transparent;
}

/* drag overlay */
.tian-annotate-drag-overlay {
  position: fixed;
  z-index: 999997;
  border: 2px dashed #6366f1;
  background: rgba(99, 102, 241, 0.08);
  pointer-events: none;
}

.tian-annotate-multiselect-overlay {
  position: fixed;
  z-index: 999997;
  border: 2px solid #6366f1;
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.12);
  pointer-events: none;
}

/* rearrange clone */
.tian-annotate-rearrange-clone {
  position: fixed;
  z-index: 999997;
  background: rgba(139, 92, 246, 0.15);
  border: 2px dashed #8b5cf6;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  color: #8b5cf6;
  pointer-events: none;
  transform: translate(-50%, -50%);
}

/* detail popup */
.tian-annotate-detail-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000001;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
}
.tian-annotate-detail {
  background: #fff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
  color: #18181b;
  width: 400px;
  max-height: 80vh;
  overflow-y: auto;
}
.tian-annotate-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 12px;
}
.tian-annotate-detail-field {
  margin-bottom: 8px;
  word-break: break-word;
}
.tian-annotate-detail-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e4e4e7;
}
.tian-annotate-detail-actions {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e4e4e7;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tian-annotate-status {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}
.tian-annotate-status--pending { background: #6366f1; color: #fff; }
.tian-annotate-status--acknowledged { background: #f59e0b; color: #fff; }
.tian-annotate-status--resolved { background: #6b7280; color: #fff; }

.tian-annotate-thread-messages {
  max-height: 160px;
  overflow-y: auto;
  margin: 6px 0;
}
.tian-annotate-thread-msg {
  padding: 4px 8px;
  border-radius: 6px;
  margin-bottom: 4px;
  font-size: 12px;
}
.tian-annotate-thread-msg--human { background: #f0f0ff; }
.tian-annotate-thread-msg--agent { background: #f0fff0; }
.tian-annotate-thread-role {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  margin-right: 4px;
}
.tian-annotate-thread-content { word-break: break-word; }
.tian-annotate-thread-input-row {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.tian-annotate-thread-role-select {
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  background: transparent;
  color: inherit;
  padding: 2px 4px;
}
.tian-annotate-btn-sm {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  background: #6366f1;
  color: #fff;
  cursor: pointer;
}
.tian-annotate-btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }

.tian-annotate-btn-status {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  cursor: pointer;
}
.tian-annotate-btn--acknowledge { background: #f59e0b; color: #fff; border-color: #f59e0b; }
.tian-annotate-btn--resolve { background: #10b981; color: #fff; border-color: #10b981; }
.tian-annotate-btn--delete { background: #ef4444; color: #fff; border-color: #ef4444; }
</style>
