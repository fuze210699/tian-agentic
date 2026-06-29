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
  getElementsInRectFromCandidates,
  getMeaningfulTarget,
  getUnionRect,
  collectAllElements,
} from './dom';
import { getVueInstance, getComponentTree, getSourceFile } from './vueTree';
import { serializeAnnotations } from './markdown';
import { COMPONENT_PALETTE } from './componentPalette';
import { dispatchAgent as dispatchAgentRequest, fetchAgentModels, fetchHealth } from './sync';
import type { Annotation, OutputFormat, Rect, ThreadMessage } from './types';
import claudeLogo from './assets/logos/claude-color.svg?raw';
import opencodeLogo from './assets/logos/opencode.svg?raw';
import agentAiLogo from './assets/logos/agent-ai.svg?raw';
import arrangeIcon from './assets/logos/arrange-icon.svg?raw';

const props = withDefaults(
  defineProps<{
    defaultFormat?: OutputFormat;
    pauseAnimations?: boolean;
    persistKey?: string;
    enableLayoutMode?: boolean;
    /** Base URL of a tian-agentic-be instance (e.g. "http://localhost:4848").
     * Unset by default — annotating stays purely client-side unless a host
     * app opts in, so existing consumers see no behavior change. */
    syncEndpoint?: string;
    /** Groups annotations server-side so multiple pages/host apps don't mix
     * into the same pending list. */
    syncSessionId?: string;
    accentColor?: string;
    blockInteractionOnCopy?: boolean;
    /** When false, the Copy button emits `copy` event instead of writing to clipboard. Default true. */
    copyToClipboard?: boolean;
  }>(),
  {
    defaultFormat: 'standard',
    pauseAnimations: true,
    enableLayoutMode: false,
    accentColor: '#6366f1',
    blockInteractionOnCopy: false,
    copyToClipboard: true,
  }
);

const emit = defineEmits<{
  'annotation-add': [annotation: Annotation];
  'annotation-delete': [id: string];
  'annotation-update': [payload: { id: string; patch: Partial<Annotation> }];
  'annotations-clear': [];
  copy: [markdown: string];
  'session-created': [sessionId: string];
}>();

const sessionCreatedEmitted = new Set<string>();

const {
  annotations,
  addAnnotation: _addAnnotation,
  updateAnnotation: _updateAnnotation,
  removeAnnotation: _removeAnnotation,
  clearAll: _clearAll,
  setStatus,
  startSync,
  stopSync,
  syncNow,
  syncEnabled,
} = useTianAnnotateStore(props.persistKey, {
  endpoint: props.syncEndpoint,
  sessionId: props.syncSessionId,
});

function addAnnotation(data: Parameters<typeof _addAnnotation>[0]): Annotation {
  const result = _addAnnotation(data);
  emit('annotation-add', result);
  return result;
}
function updateAnnotation(id: string, patch: Partial<Annotation>) {
  _updateAnnotation(id, patch);
  emit('annotation-update', { id, patch });
}
function removeAnnotation(id: string) {
  _removeAnnotation(id);
  emit('annotation-delete', id);
  removePinGhost(id);
}
function clearAll() {
  _clearAll();
  emit('annotations-clear');
  clearAllPinGhosts();
}
const active = ref(false);
const hoverTarget = ref<Element | null>(null);
const precise = ref(false);
const mouseX = ref(0);
const mouseY = ref(0);
// Tracked explicitly because window.scrollX/scrollY aren't reactive — without
// this, the fixed-position drag/multi-select overlays (computed from
// document coordinates minus current scroll) would freeze at whatever scroll
// position was last read, drifting away from the actual elements as the page
// scrolls instead of staying glued to them.
const scrollPos = ref({ x: 0, y: 0 });
const format = ref<OutputFormat>(props.defaultFormat);
const copyState = ref<'idle' | 'copied'>('idle');
const clearState = ref<'idle' | 'cleared'>('idle');
const mode = ref<'feedback' | 'placement' | 'rearrange'>('feedback');
const filterStatus = ref<'all' | 'pending' | 'acknowledged' | 'resolved'>('all');
const animationsPaused = ref(props.pauseAnimations);
const pinsVisible = ref(true);
const showSettings = ref(false);
const accentColorLocal = ref(props.accentColor);
const blockInteractionEnabled = ref(props.blockInteractionOnCopy);
const wireframeEnabled = ref(false);
const wireframeOpacity = ref(60);
const wireframeGridSize = ref(100);
const viewportSize = ref({ w: window.innerWidth, h: window.innerHeight });

function onWindowResize() {
  viewportSize.value = { w: window.innerWidth, h: window.innerHeight };
}

const wireframeTicksX = computed(() => {
  const ticks: { pos: number; label: number }[] = [];
  for (let x = 0; x <= viewportSize.value.w; x += wireframeGridSize.value) {
    ticks.push({ pos: x, label: Math.round(x + scrollPos.value.x) });
  }
  return ticks;
});

const wireframeTicksY = computed(() => {
  const ticks: { pos: number; label: number }[] = [];
  for (let y = 0; y <= viewportSize.value.h; y += wireframeGridSize.value) {
    ticks.push({ pos: y, label: Math.round(y + scrollPos.value.y) });
  }
  return ticks;
});
let blockOverlay: HTMLDivElement | null = null;
// Ghost actively following the cursor for the drag currently in progress.
let rearrangeGhostNode: HTMLElement | null = null;
let rearrangeGhostRafId: number | null = null;
let rearrangeGhostPendingX = 0;
let rearrangeGhostPendingY = 0;
// Ghost frozen at the drop spot while the confirm popup is open, waiting to
// find out whether it becomes a real pin (confirm) or gets discarded (cancel).
let pendingDropGhost: HTMLElement | null = null;
// Ghosts that belong to a confirmed rearrange annotation, keyed by annotation
// id — these live exactly as long as their pin does (see removeAnnotation /
// clearAll below), independent of drag/mode/active state.
const rearrangePinGhosts = new Map<string, HTMLElement>();

function ghostTransform(x: number, y: number) {
  return `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
}

function removeRearrangeGhost() {
  if (rearrangeGhostRafId !== null) {
    cancelAnimationFrame(rearrangeGhostRafId);
    rearrangeGhostRafId = null;
  }
  rearrangeGhostNode?.remove();
  rearrangeGhostNode = null;
}

function discardPendingDropGhost() {
  pendingDropGhost?.remove();
  pendingDropGhost = null;
}

function commitPendingDropGhost(annotationId: string, rect: Rect, isFixed: boolean) {
  if (!pendingDropGhost) return;
  const node = pendingDropGhost;
  pendingDropGhost = null;
  // Switch from viewport-relative (position: fixed, used while tracking the
  // cursor) to document-relative so the ghost scrolls with the page like its
  // pin does, instead of staying pinned to the viewport forever.
  Object.assign(node.style, {
    position: isFixed ? 'fixed' : 'absolute',
    left: rect.x + 'px',
    top: rect.y + 'px',
    transform: 'none',
  });
  rearrangePinGhosts.set(annotationId, node);
}

function removePinGhost(annotationId: string) {
  rearrangePinGhosts.get(annotationId)?.remove();
  rearrangePinGhosts.delete(annotationId);
}

function clearAllPinGhosts() {
  for (const node of rearrangePinGhosts.values()) node.remove();
  rearrangePinGhosts.clear();
}

function injectBlockInteraction(durationMs = 400) {
  if (!blockInteractionEnabled.value) return;
  if (blockOverlay) blockOverlay.remove();
  blockOverlay = document.createElement('div');
  blockOverlay.className = 'tian-annotate-ignore';
  blockOverlay.style.cssText = 'position:fixed;inset:0;z-index:9999999;pointer-events:none;';
  document.body.appendChild(blockOverlay);
  setTimeout(() => {
    blockOverlay?.remove();
    blockOverlay = null;
  }, durationMs);
}

// Per-browser agent model preference (not per-annotation), shared across
// sessions on this machine — separate from persistKey'd annotation storage
// since the model choice has nothing to do with any one project's data.
const AGENT_MODELS_STORAGE_KEY = 'tian-annotate-agent-models';
const claudeModel = ref('');
const opencodeModel = ref('');
try {
  const raw = localStorage.getItem(AGENT_MODELS_STORAGE_KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    claudeModel.value = saved.claude || '';
    opencodeModel.value = saved.opencode || '';
  }
} catch {
  /* ignore corrupt data */
}
watch([claudeModel, opencodeModel], () => {
  try {
    localStorage.setItem(
      AGENT_MODELS_STORAGE_KEY,
      JSON.stringify({ claude: claudeModel.value, opencode: opencodeModel.value })
    );
  } catch {
    /* ignore quota errors */
  }
});

// Curated fallback shown if the backend can't be reached or returns nothing
// (e.g. opencode isn't installed on the backend host) — keeps the dropdown
// usable instead of empty.
const FALLBACK_CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
];
const claudeModelOptions = ref<string[]>([]);
const opencodeModelOptions = ref<string[]>([]);
const modelsLoading = ref(false);
const modelsError = ref('');
let modelsLoaded = false;

async function loadAgentModels(force = false) {
  if (!props.syncEndpoint || (modelsLoaded && !force)) return;
  modelsLoading.value = true;
  modelsError.value = '';
  const sessionId = props.syncSessionId || 'default';
  const [claudeResult, opencodeResult] = await Promise.all([
    fetchAgentModels(props.syncEndpoint, 'claude', sessionId),
    fetchAgentModels(props.syncEndpoint, 'opencode', sessionId),
  ]);
  claudeModelOptions.value = claudeResult.models.length
    ? claudeResult.models
    : FALLBACK_CLAUDE_MODELS;
  opencodeModelOptions.value = opencodeResult.models;
  modelsError.value = opencodeResult.error || claudeResult.error || '';
  modelsLoading.value = false;
  modelsLoaded = true;
}

watch(showSettings, (val: boolean) => {
  if (val) loadAgentModels();
});

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
const editingComment = ref(false);
const editCommentText = ref('');
const dispatching = ref<'claude' | 'opencode' | null>(null);
const dispatchError = ref('');
const defaultAgent = ref<'claude' | 'opencode' | null>(null);

const dragStart = ref<{ x: number; y: number } | null>(null);
const dragRect = ref<Rect | null>(null);
const dragEl = ref<Element | null>(null);
const rearrangeDragging = ref(false);
const wasDragging = ref(false);
const multiSelectGroupRect = ref<Rect | null>(null);

const liveMultiSelectEls = ref<Element[]>([]);
let lastElementHitTestAt = 0;
const ELEMENT_UPDATE_THROTTLE_MS = 50;
let cachedAllElements: Element[] = [];

// Shift+click multi-select: each click while Shift is held toggles 1 item
// into the set; releasing Shift finalizes the group (same popup as
// Shift+drag marquee select). Distinct from liveMultiSelectEls above, which
// is for the drag-rectangle flow.
const shiftMultiSelectEls = ref<Element[]>([]);

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

// ---- suppress native text selection while marquee-dragging (Shift+drag) ----
function disableTextSelection() {
  document.documentElement.classList.add('tian-annotate-no-select');
  window.getSelection()?.removeAllRanges();
}
function enableTextSelection() {
  document.documentElement.classList.remove('tian-annotate-no-select');
}

watch(active, (val) => {
  if (val && animationsPaused.value) injectAnimPause();
  else removeAnimPause();
  if (!val) {
    dragStart.value = null;
    dragRect.value = null;
    dragEl.value = null;
    rearrangeDragging.value = false;
    wasDragging.value = false;
    showSettings.value = false;
    enableTextSelection();
    clearShiftMultiSelect();
    removeRearrangeGhost();
    discardPendingDropGhost();
  }
});

watch(mode, (val: 'feedback' | 'placement' | 'rearrange') => {
  if (val !== 'rearrange') removeRearrangeGhost();
});

watch(pinsVisible, (visible: boolean) => {
  for (const node of rearrangePinGhosts.values()) {
    node.style.display = visible ? '' : 'none';
  }
});

watch(mode, () => clearShiftMultiSelect());

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

function composedTarget(e: MouseEvent): EventTarget {
  return e.composedPath?.()[0] ?? e.target;
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
  for (const el of liveMultiSelectEls.value)
    el.classList.remove('tian-annotate-multiselect-item-outline');
  liveMultiSelectEls.value = [];
}

function clearShiftMultiSelect() {
  for (const el of shiftMultiSelectEls.value)
    el.classList.remove('tian-annotate-multiselect-item-outline');
  shiftMultiSelectEls.value = [];
}

function toggleShiftMultiSelect(el: Element) {
  const idx = shiftMultiSelectEls.value.indexOf(el);
  if (idx !== -1) {
    el.classList.remove('tian-annotate-multiselect-item-outline');
    shiftMultiSelectEls.value.splice(idx, 1);
  } else {
    el.classList.add('tian-annotate-multiselect-item-outline');
    shiftMultiSelectEls.value.push(el);
  }
}

// Shift released — turn whatever got toggled on into the same "multi-select"
// pendingPick flow Shift+drag produces (group bounding box + nearbyElements),
// instead of opening anything per individual click.
function finalizeShiftMultiSelect() {
  const els = shiftMultiSelectEls.value;
  if (!els.length || pendingPick.el || selectedAnnotation.value) return;

  const descriptions = els.map((el) => describeElement(el)).slice(0, 10);
  multiSelectGroupRect.value = getUnionRect(els);
  pendingPick.el = els[0];
  pendingPick.x = Math.min(mouseX.value, window.innerWidth - 260);
  pendingPick.y = Math.min(mouseY.value, window.innerHeight - 220);
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

  for (const el of els) el.classList.remove('tian-annotate-multiselect-item-outline');
  shiftMultiSelectEls.value = [];
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === 'Shift') finalizeShiftMultiSelect();
}

function onWindowBlur() {
  // If Shift is released while the window doesn't have focus (e.g.
  // Alt+Tab), no keyup ever fires — finalize on blur too so toggled items
  // don't stay outlined forever with no way to complete the selection.
  finalizeShiftMultiSelect();
}

function isEditableTarget(e: KeyboardEvent): boolean {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

function handleKeyDown(e: KeyboardEvent) {
  if (isEditableTarget(e)) return;

  const mod = e.metaKey || e.ctrlKey;

  // Ctrl/Cmd+Shift+F: toggle active (always available)
  if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    toggleActive();
    return;
  }

  if (!active.value) return;

  if (e.key === 'Escape') {
    if (selectedAnnotation.value) {
      closeDetail();
    } else if (pendingPick.el) {
      cancelPick();
    } else if (showSettings.value) {
      showSettings.value = false;
    } else {
      toggleActive();
    }
    return;
  }

  if (e.key.toLowerCase() === 'l' && props.enableLayoutMode) {
    // Cycle layout mode (feedback → placement → rearrange → feedback)
    mode.value =
      mode.value === 'feedback'
        ? 'placement'
        : mode.value === 'placement'
          ? 'rearrange'
          : 'feedback';
    return;
  }

  if (e.key.toLowerCase() === 'p') {
    toggleAnimationsPaused();
    return;
  }

  if (e.key.toLowerCase() === 'h') {
    togglePinsVisible();
    return;
  }

  if (e.key.toLowerCase() === 'c') {
    if (filteredAnnotations.value.length) copyMarkdown();
    return;
  }

  if (e.key.toLowerCase() === 'x') {
    if (annotations.length) clearAll();
    return;
  }
}

// ---- event handlers ----
function onMouseDown(e: MouseEvent) {
  if (!active.value || isIgnored(composedTarget(e))) return;
  const target = composedTarget(e) as Element;

  if (mode.value === 'rearrange') {
    e.preventDefault();
    const el = getMeaningfulTarget(target, { precise: e.altKey });
    if (el && el !== document.body && el !== document.documentElement) {
      dragStart.value = { x: e.clientX, y: e.clientY };
      dragEl.value = el;
      rearrangeDragging.value = true;
      wasDragging.value = false;
    }
    return;
  }

  if (mode.value === 'feedback') {
    // Shift+drag means "marquee multi-select" — block native text selection
    // from starting at all, rather than racing it. A plain drag (no Shift)
    // is left alone so normal text selection works, picked up by onClick's
    // window.getSelection() check for the "annotate this text" flow.
    if (e.shiftKey) e.preventDefault();
    dragStart.value = { x: e.clientX, y: e.clientY };
    wasDragging.value = false;
  }
}

function onScroll() {
  scrollPos.value = { x: window.scrollX, y: window.scrollY };
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

      if (!rearrangeGhostNode) {
        const el = dragEl.value;
        const rect = el.getBoundingClientRect();
        const NO_CLONE_TAGS = ['VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED'];
        let clone: HTMLElement;
        if (NO_CLONE_TAGS.includes(el.tagName)) {
          clone = document.createElement('div');
          clone.style.display = 'flex';
          clone.style.alignItems = 'center';
          clone.style.justifyContent = 'center';
          clone.style.fontSize = '11px';
          clone.style.fontFamily = 'ui-monospace, monospace';
          clone.style.color = '#8b5cf6';
          clone.style.background = 'rgba(139, 92, 246, 0.15)';
          clone.textContent = describeElement(el);
        } else {
          clone = el.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
          clone.removeAttribute('id');
        }
        Object.assign(clone.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: rect.width + 'px',
          height: rect.height + 'px',
          margin: '0',
          pointerEvents: 'none',
          zIndex: '999997',
          willChange: 'transform',
          transform: ghostTransform(e.clientX, e.clientY),
        });
        clone.classList.add('tian-annotate-rearrange-ghost', 'tian-annotate-ignore');
        // The clone keeps the page's own classes, so if the original element's
        // stylesheet defines a `transition` on transform/position, the clone
        // would ease toward each new spot instead of snapping — looking like
        // the ghost lags behind the cursor. Force it off with !important so
        // no page rule can win the specificity/order fight.
        clone.style.setProperty('transition', 'none', 'important');
        clone.querySelectorAll<HTMLElement>('*').forEach((n) =>
          n.style.setProperty('transition', 'none', 'important'),
        );
        const badge = document.createElement('span');
        badge.style.cssText =
          'position:absolute;top:0;left:0;font-size:10px;font-family:ui-monospace,monospace;color:#8b5cf6;background:rgba(139,92,246,0.15);padding:1px 6px;border-radius:0 0 6px 0;white-space:nowrap;pointer-events:none;';
        badge.textContent = describeElement(el);
        clone.appendChild(badge);
        document.body.appendChild(clone);
        rearrangeGhostNode = clone;
      } else {
        // Batch position updates to one transform write per animation frame —
        // moving via left/top forces layout on every mousemove and is what
        // caused the visible stutter; transform is compositor-only.
        rearrangeGhostPendingX = e.clientX;
        rearrangeGhostPendingY = e.clientY;
        if (rearrangeGhostRafId === null) {
          rearrangeGhostRafId = requestAnimationFrame(() => {
            rearrangeGhostRafId = null;
            rearrangeGhostNode?.style.setProperty(
              'transform',
              ghostTransform(rearrangeGhostPendingX, rearrangeGhostPendingY),
            );
          });
        }
      }
    }
    return;
  }

  if (
    dragStart.value &&
    !dragEl.value &&
    mode.value === 'feedback' &&
    (e.shiftKey || wasDragging.value)
  ) {
    const dx = e.clientX - dragStart.value.x;
    const dy = e.clientY - dragStart.value.y;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      // The few pixels of movement before this threshold fires still ran the
      // normal single-element hover-highlight below (it only returns once
      // wasDragging is true) — clear that stray outline now that we know
      // this is a drag-select, not a single click.
      clearHighlight();
      if (!wasDragging.value) {
        disableTextSelection();
        cachedAllElements = collectAllElements();
      }
      wasDragging.value = true;
      const left = Math.min(dragStart.value.x, e.clientX);
      const top = Math.min(dragStart.value.y, e.clientY);
      dragRect.value = {
        x: left + window.scrollX,
        y: top + window.scrollY,
        width: Math.abs(dx),
        height: Math.abs(dy),
      };

      const now = performance.now();
      if (now - lastElementHitTestAt >= ELEMENT_UPDATE_THROTTLE_MS) {
        lastElementHitTestAt = now;
        const els = getElementsInRectFromCandidates(cachedAllElements, {
          left: Math.min(dragStart.value!.x, e.clientX),
          top: Math.min(dragStart.value!.y, e.clientY),
          width: Math.abs(dx),
          height: Math.abs(dy),
        });
        for (const el of liveMultiSelectEls.value) {
          if (!els.includes(el)) el.classList.remove('tian-annotate-multiselect-item-outline');
        }
        for (const el of els) {
          if (!liveMultiSelectEls.value.includes(el))
            el.classList.add('tian-annotate-multiselect-item-outline');
        }
        liveMultiSelectEls.value = els;
      }
      return;
    }
  }

  if (pendingPick.el || selectedAnnotation.value) return;
  const rawTarget = composedTarget(e) as Element;
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
  enableTextSelection();

  if (
    dragRect.value &&
    wasDragging.value &&
    dragRect.value.width >= DRAG_MIN_SIZE &&
    dragRect.value.height >= DRAG_MIN_SIZE
  ) {
    const rect = dragRect.value;
    const left = rect.x - window.scrollX;
    const top = rect.y - window.scrollY;
    const els = liveMultiSelectEls.value.length
      ? liveMultiSelectEls.value
      : getElementsInRect({ left, top, width: rect.width, height: rect.height });
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
    } else {
      // Area mode: drag-selected region contains 0 elements — annotate an empty area
      pendingPick.el = null;
      pendingPick.x = Math.min(e.clientX, window.innerWidth - 260);
      pendingPick.y = Math.min(e.clientY, window.innerHeight - 220);
      pendingPick.comment = '';
      pendingPick.intent = '';
      pendingPick.severity = '';
      pendingPick.selectedText = '';
      pendingPick.isMultiSelect = true;
      pendingPick.nearbyElements = '';
      pendingPick.componentType = '';
      pendingPick.placementWidth = 100;
      pendingPick.placementHeight = 40;
      pendingPick.placementText = '';
      pendingPick.rearrangeLabel = '';
      pendingPick.rearrangeSelector = '';
      pendingPick.rearrangeTagName = '';
      pendingPick.rearrangeOriginalRect = dragRect.value;
      pendingPick.rearrangeCurrentRect = null;
      pendingPick.rearrangeIsFixed = false;
    }
    for (const el of liveMultiSelectEls.value)
      el.classList.remove('tian-annotate-multiselect-item-outline');
    liveMultiSelectEls.value = [];
    cachedAllElements = [];
    dragStart.value = null;
    dragRect.value = null;
    return;
  }

  if (rearrangeDragging.value && wasDragging.value && dragEl.value) {
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
    rearrangeDragging.value = false;
    // Hand the ghost off to "pending" — frozen at the drop spot, faded, while
    // the confirm popup decides its fate (confirmPick turns it into a pin
    // ghost that outlives this popup; cancelPick discards it). Clearing
    // rearrangeGhostNode here lets the very next drag create its own ghost
    // immediately, independent of this one's outcome.
    if (rearrangeGhostRafId !== null) {
      cancelAnimationFrame(rearrangeGhostRafId);
      rearrangeGhostRafId = null;
    }
    rearrangeGhostNode?.style.setProperty('transform', ghostTransform(e.clientX, e.clientY));
    rearrangeGhostNode?.classList.add('tian-annotate-rearrange-ghost--dropped');
    pendingDropGhost = rearrangeGhostNode;
    rearrangeGhostNode = null;
    return;
  }

  for (const el of liveMultiSelectEls.value)
    el.classList.remove('tian-annotate-multiselect-item-outline');
  liveMultiSelectEls.value = [];
  cachedAllElements = [];
  dragStart.value = null;
  dragRect.value = null;
  dragEl.value = null;
  rearrangeDragging.value = false;
  removeRearrangeGhost();
}

function onClick(e: MouseEvent) {
  if (!active.value || isIgnored(composedTarget(e)) || pendingPick.el || selectedAnnotation.value)
    return;
  if (wasDragging.value) {
    wasDragging.value = false;
    return;
  }

  // Shift+click: toggle 1 item into the multi-select set instead of opening
  // the regular single-element popup. The group finalizes on Shift keyup.
  if (e.shiftKey && mode.value === 'feedback') {
    e.preventDefault();
    e.stopPropagation();
    const el = getMeaningfulTarget(composedTarget(e) as Element, { preferContainer: true });
    if (el && el !== document.body && el !== document.documentElement) {
      toggleShiftMultiSelect(el);
    }
    return;
  }

  if (mode.value === 'placement') {
    e.preventDefault();
    e.stopPropagation();
    pendingPick.el = getMeaningfulTarget(composedTarget(e) as Element, { precise: e.altKey });
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

  pendingPick.el = getMeaningfulTarget(composedTarget(e) as Element, { precise: e.altKey });
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
    clearShiftMultiSelect();
    pendingPick.el = null;
    selectedAnnotation.value = null;
    removeRearrangeGhost();
    discardPendingDropGhost();
  }
}

function cancelPick() {
  pendingPick.el = null;
  pendingPick.rearrangeOriginalRect = null;
  pendingPick.rearrangeCurrentRect = null;
  clearHighlight();
  clearMultiSelectHighlight();
  wasDragging.value = false;
  removeRearrangeGhost();
  discardPendingDropGhost();
}

function confirmPick() {
  const el = pendingPick.el;
  clearMultiSelectHighlight();

  if (mode.value === 'placement') {
    if (!pendingPick.comment.trim() || !pendingPick.componentType.trim()) return;
    const box = el
      ? getBoundingBox(el)
      : { x: pendingPick.x, y: pendingPick.y, width: 1, height: 1 };
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

  if (
    mode.value === 'rearrange' &&
    pendingPick.rearrangeOriginalRect &&
    pendingPick.rearrangeCurrentRect
  ) {
    if (!pendingPick.comment.trim()) return;
    const rearrangeWidthBasis = pendingPick.rearrangeIsFixed
      ? window.innerWidth
      : document.documentElement.scrollWidth;
    const annotation = addAnnotation({
      kind: 'rearrange',
      comment: pendingPick.comment.trim(),
      elementPath: pendingPick.rearrangeSelector,
      element: pendingPick.rearrangeTagName,
      x:
        Math.round((pendingPick.rearrangeCurrentRect.x / Math.max(rearrangeWidthBasis, 1)) * 1000) /
        10,
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
    // The ghost's lifetime now follows its pin's: it stays on screen (faded)
    // until this annotation is deleted, via removeAnnotation/clearAll above.
    commitPendingDropGhost(
      annotation.id,
      pendingPick.rearrangeCurrentRect,
      pendingPick.rearrangeIsFixed,
    );
    pendingPick.rearrangeOriginalRect = null;
    pendingPick.rearrangeCurrentRect = null;
    return;
  }

  if (!pendingPick.comment.trim()) return;

  // Area mode: drag-selected region without any elements
  if (!el && pendingPick.isMultiSelect && pendingPick.rearrangeOriginalRect) {
    const areaRect = pendingPick.rearrangeOriginalRect;
    addAnnotation({
      kind: 'area',
      comment: pendingPick.comment.trim(),
      elementPath: '',
      element: '',
      x: Math.round(((areaRect.x - window.scrollX) / Math.max(window.innerWidth, 1)) * 1000) / 10,
      y: areaRect.y,
      url: window.location.href,
      boundingBox: areaRect,
      intent: pendingPick.intent || undefined,
      severity: pendingPick.severity || undefined,
      area: {
        rect: areaRect,
        scrollY: Math.round(window.scrollY),
      },
    });
    pendingPick.el = null;
    clearHighlight();
    wasDragging.value = false;
    return;
  }

  if (!el) return;

  const instance = getVueInstance(el);
  const componentTree = instance
    ? getComponentTree(instance, format.value === 'detailed')
    : undefined;
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
  if (a.kind === 'area') return 'tian-annotate-pin tian-annotate-pin--area';
  return `tian-annotate-pin tian-annotate-pin--${a.status || 'pending'}`;
}

async function copyMarkdown() {
  const md = serializeAnnotations(filteredAnnotations.value, format.value);
  if (props.copyToClipboard) {
    await navigator.clipboard.writeText(md);
  }
  emit('copy', md);
  copyState.value = 'copied';
  injectBlockInteraction(400);
  setTimeout(() => (copyState.value = 'idle'), 1500);
}

function handleClearAll() {
  if (!annotations.length) return;
  clearAll();
  clearState.value = 'cleared';
  setTimeout(() => (clearState.value = 'idle'), 1500);
}

function selectAnnotation(a: Annotation) {
  selectedAnnotation.value = a;
  editingComment.value = false;
  dispatching.value = null;
  dispatchError.value = '';
}

function closeDetail() {
  selectedAnnotation.value = null;
  editingComment.value = false;
}

function startEditComment() {
  if (!selectedAnnotation.value || selectedAnnotation.value.status === 'resolved') return;
  editCommentText.value = selectedAnnotation.value.comment;
  editingComment.value = true;
}

function cancelEditComment() {
  editingComment.value = false;
}

function saveEditComment() {
  if (!selectedAnnotation.value) return;
  const comment = editCommentText.value.trim();
  if (!comment) return;
  updateAnnotation(selectedAnnotation.value.id, { comment });
  const updated = annotations.find((a) => a.id === selectedAnnotation.value!.id);
  if (updated) selectedAnnotation.value = updated;
  editingComment.value = false;
}

async function runAgent(agent: 'claude' | 'opencode') {
  if (!selectedAnnotation.value || !props.syncEndpoint || dispatching.value) return;
  dispatching.value = agent;
  dispatchError.value = '';
  const model = (agent === 'claude' ? claudeModel.value : opencodeModel.value).trim();
  const result = await dispatchAgentRequest(
    props.syncEndpoint,
    selectedAnnotation.value.id,
    agent,
    model || undefined
  );
  dispatching.value = null;
  if (!result.ok) dispatchError.value = result.error || 'Failed to start agent';
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
  return {
    left: dragRect.value.x - scrollPos.value.x + 'px',
    top: dragRect.value.y - scrollPos.value.y + 'px',
    width: dragRect.value.width + 'px',
    height: dragRect.value.height + 'px',
  };
});

const rearrangeArrow = computed(() => {
  if (dragEl.value && wasDragging.value && mode.value === 'rearrange') {
    const rect = dragEl.value.getBoundingClientRect();
    return {
      x1: rect.left + rect.width / 2,
      y1: rect.top + rect.height / 2,
      x2: mouseX.value,
      y2: mouseY.value,
    };
  }
  if (
    pendingPick.rearrangeOriginalRect &&
    pendingPick.rearrangeCurrentRect &&
    mode.value === 'rearrange'
  ) {
    const o = pendingPick.rearrangeOriginalRect;
    const c = pendingPick.rearrangeCurrentRect;
    const sx = pendingPick.rearrangeIsFixed ? 0 : scrollPos.value.x;
    const sy = pendingPick.rearrangeIsFixed ? 0 : scrollPos.value.y;
    return {
      x1: o.x + o.width / 2 - sx,
      y1: o.y + o.height / 2 - sy,
      x2: c.x + c.width / 2 - sx,
      y2: c.y + c.height / 2 - sy,
    };
  }
  return null;
});

const multiSelectGroupOverlayStyle = computed(() => {
  if (!multiSelectGroupRect.value) return {};
  return {
    left: multiSelectGroupRect.value.x - scrollPos.value.x + 'px',
    top: multiSelectGroupRect.value.y - scrollPos.value.y + 'px',
    width: multiSelectGroupRect.value.width + 'px',
    height: multiSelectGroupRect.value.height + 'px',
  };
});

const annotationCountLabel = computed(
  () =>
    `${filteredAnnotations.value.length}/${annotations.length} annotation${annotations.length === 1 ? '' : 's'}`
);

const syncEndpointHost = computed(() => {
  if (!props.syncEndpoint) return '';
  try {
    return new URL(props.syncEndpoint).host;
  } catch {
    return props.syncEndpoint;
  }
});

// Backend posts a "Dispatching <agent> to fix this (headless run started…)"
// thread message when a run starts, then a "run finished"/"exited with
// code"/"Failed to start" message when it ends (see tian-agentic-be
// dispatch.ts). `dispatching` only covers the brief POST round-trip, not the
// actual (multi-minute) agent run, so derive the real running state from the
// thread itself — it stays true across reloads/polls until a finish message
// for that dispatch shows up.
const agentRunStatus = computed(() => {
  if (dispatching.value) return { agent: dispatching.value };
  const thread = selectedAnnotation.value?.thread;
  if (!thread?.length) return null;
  let dispatchIdx = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (/^Dispatching (\S+)/.test(thread[i].content)) {
      dispatchIdx = i;
      break;
    }
  }
  if (dispatchIdx === -1) return null;
  const finished = thread
    .slice(dispatchIdx + 1)
    .some((m: ThreadMessage) => /run finished|exited with code|Failed to start/.test(m.content));
  if (finished) return null;
  const match = thread[dispatchIdx].content.match(/^Dispatching (\S+)/);
  return { agent: match ? match[1] : 'agent' };
});

function formatRelativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

// CSS custom properties only cascade to DOM *descendants* of where they're
// set. The toolbar is rendered as a sibling overlay next to the host page's
// content, not wrapping it — so binding `--tian-accent` only on the toolbar
// root (as a :style) never reaches page elements that get
// `.tian-annotate-hover-outline`/`.tian-annotate-multiselect-item-outline`
// etc. applied directly. Setting it on `documentElement` instead makes it
// visible to the entire page, toolbar included, regardless of where in the
// tree either side renders.
watch(
  accentColorLocal,
  (val: string) => {
    document.documentElement.style.setProperty('--tian-accent', val);
  },
  { immediate: true }
);

onMounted(() => {
  scrollPos.value = { x: window.scrollX, y: window.scrollY };
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onWindowResize);
  startSync();
  if (props.syncEndpoint) {
    fetchHealth(props.syncEndpoint).then((r) => {
      defaultAgent.value = r.defaultAgent;
    });
  }
  if (
    props.syncEndpoint &&
    props.syncSessionId &&
    !sessionCreatedEmitted.has(props.syncSessionId)
  ) {
    sessionCreatedEmitted.add(props.syncSessionId);
    emit('session-created', props.syncSessionId);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onMouseDown, true);
  window.removeEventListener('mousemove', onMouseMove, true);
  window.removeEventListener('mouseup', onMouseUp, true);
  window.removeEventListener('click', onClick, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('keydown', handleKeyDown, true);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('resize', onWindowResize);
  stopSync();
  clearHighlight();
  clearMultiSelectHighlight();
  clearShiftMultiSelect();
  removeAnimPause();
  document.documentElement.style.removeProperty('--tian-accent');
  enableTextSelection();
  removeRearrangeGhost();
  discardPendingDropGhost();
  clearAllPinGhosts();
});
</script>

<template>
  <div
    class="tian-annotate-toolbar tian-annotate-ignore"
    :style="{ '--tian-accent': accentColorLocal }"
  >
    <!-- Settings popover (format level, layout mode, status filter) -->
    <Transition name="tian-panel">
      <div v-if="active && showSettings" class="tian-annotate-panel">
        <div class="tian-annotate-panel-header">
          <span class="tian-annotate-panel-title">Settings</span>
          <span class="tian-annotate-panel-count">{{ annotationCountLabel }}</span>
        </div>

        <div class="tian-annotate-panel-section">
          <label class="tian-annotate-panel-label">Markdown format</label>
          <select v-model="format" class="tian-annotate-panel-select">
            <option value="compact">Compact</option>
            <option value="standard">Standard</option>
            <option value="detailed">Detailed</option>
            <option value="forensic">Forensic</option>
          </select>
        </div>

        <div v-if="props.enableLayoutMode" class="tian-annotate-panel-section">
          <label class="tian-annotate-panel-label">Mode</label>
          <select v-model="mode" class="tian-annotate-panel-select">
            <option value="feedback">Feedback</option>
            <option value="placement">Placement</option>
            <option value="rearrange">Rearrange</option>
          </select>
        </div>

        <div class="tian-annotate-panel-section">
          <label class="tian-annotate-panel-label">Filter</label>
          <select v-model="filterStatus" class="tian-annotate-panel-select">
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>

        <template v-if="syncEnabled">
          <div class="tian-annotate-panel-divider"></div>
          <div class="tian-annotate-panel-section-title">
            Agent models
            <button
              type="button"
              class="tian-annotate-panel-refresh"
              :disabled="modelsLoading"
              title="Refresh model list"
              @click="loadAgentModels(true)"
            >
              {{ modelsLoading ? '…' : '↻' }}
            </button>
          </div>

          <div class="tian-annotate-panel-section">
            <label class="tian-annotate-panel-label">
              <span class="tian-annotate-panel-label-icon" v-html="claudeLogo"></span>
              Claude
            </label>
            <select v-model="claudeModel" class="tian-annotate-panel-select">
              <option value="">Default (CLI config)</option>
              <option v-for="m in claudeModelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>

          <div class="tian-annotate-panel-section">
            <label class="tian-annotate-panel-label">
              <span class="tian-annotate-panel-label-icon" v-html="opencodeLogo"></span>
              OpenCode
            </label>
            <select v-model="opencodeModel" class="tian-annotate-panel-select">
              <option value="">Default (CLI config)</option>
              <option v-for="m in opencodeModelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
            <span
              v-if="!modelsLoading && !opencodeModelOptions.length"
              class="tian-annotate-panel-hint"
            >
              Couldn't fetch OpenCode models{{ modelsError ? `: ${modelsError}` : '' }}
            </span>
          </div>
        </template>

        <div class="tian-annotate-panel-divider"></div>
        <div class="tian-annotate-panel-section">
          <label class="tian-annotate-panel-label">Accent color</label>
          <input v-model="accentColorLocal" type="color" class="tian-annotate-panel-color" />
        </div>

        <div v-if="props.blockInteractionOnCopy !== undefined" class="tian-annotate-panel-section">
          <label class="tian-annotate-panel-label">Block interaction on copy</label>
          <input
            v-model="blockInteractionEnabled"
            type="checkbox"
            class="tian-annotate-panel-check"
          />
        </div>

        <template v-if="props.enableLayoutMode">
          <div class="tian-annotate-panel-divider"></div>
          <div class="tian-annotate-panel-section">
            <label class="tian-annotate-panel-label">Wireframe view</label>
            <input v-model="wireframeEnabled" type="checkbox" class="tian-annotate-panel-check" />
          </div>
          <div v-if="wireframeEnabled" class="tian-annotate-panel-section">
            <label class="tian-annotate-panel-label">Wireframe opacity</label>
            <input
              v-model.number="wireframeOpacity"
              type="range"
              min="0"
              max="100"
              class="tian-annotate-panel-range"
            />
          </div>
          <div v-if="wireframeEnabled" class="tian-annotate-panel-section">
            <label class="tian-annotate-panel-label">Grid size</label>
            <select v-model.number="wireframeGridSize" class="tian-annotate-panel-select">
              <option :value="25">25px</option>
              <option :value="50">50px</option>
              <option :value="100">100px</option>
              <option :value="200">200px</option>
            </select>
          </div>
        </template>
      </div>
    </Transition>

    <!-- Wireframe overlay: desaturates the page underneath via backdrop-filter
         so placement proposals can be judged against a low-fidelity view,
         without touching the page's own DOM/CSS. pointer-events: none keeps
         hover/click annotation working right through it.

         Teleported to body (instead of staying a child of the toolbar root)
         so its z-index is compared directly against the ghost/toolbar/modals
         at the same level — the toolbar root is itself `position: fixed` with
         z-index 999999, which creates its own stacking context, so any
         child's lower z-index only orders it among toolbar's *other*
         children and gets ignored once compared to siblings outside the
         toolbar (the ghost clone, popups) where the whole toolbar box wins
         outright at 999999. Being a sibling of those instead makes its own
         z-index (999990-999992, see CSS) actually take effect, keeping it
         behind the rearrange ghost (999997), the toolbar (999999), and the
         confirm/detail modals (1000000+). -->
    <Teleport to="body">
      <template v-if="wireframeEnabled">
        <div
          class="tian-annotate-wireframe-overlay tian-annotate-ignore"
          :style="{ opacity: wireframeOpacity / 100 }"
        />
        <!-- Grid + rulers: gives the desaturated overlay an actual spatial
             reference (like Photoshop's ruler) so placement proposals can be
             judged by position/size, not just "looks roughly right". -->
        <div
          class="tian-annotate-wireframe-grid tian-annotate-ignore"
          :style="{ backgroundSize: `${wireframeGridSize}px ${wireframeGridSize}px` }"
        />
        <div class="tian-annotate-wireframe-ruler-top tian-annotate-ignore">
          <span
            v-for="t in wireframeTicksX"
            :key="'x' + t.pos"
            class="tian-annotate-wireframe-tick-x"
            :style="{ left: t.pos + 'px' }"
            >{{ t.label }}</span
          >
        </div>
        <div class="tian-annotate-wireframe-ruler-left tian-annotate-ignore">
          <span
            v-for="t in wireframeTicksY"
            :key="'y' + t.pos"
            class="tian-annotate-wireframe-tick-y"
            :style="{ top: t.pos + 'px' }"
            >{{ t.label }}</span
          >
        </div>
      </template>
    </Teleport>

    <Transition name="tian-toolbar" mode="out-in">
      <!-- Inactive: round "+" toggle -->
      <button
        v-if="!active"
        type="button"
        class="tian-annotate-toggle"
        aria-label="Start annotating"
        @click="toggleActive"
      >
        <span class="tian-annotate-toggle-icon" v-html="agentAiLogo"></span>
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
          <svg
            v-if="!animationsPaused"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
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
          <svg
            v-if="pinsVisible"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M17.94 17.94A10.94 10.94 0 0112 19c-7 0-11-7-11-7a18.5 18.5 0 015.06-5.94M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 7 11 7a18.5 18.5 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24"
            />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        </button>

        <span class="tian-annotate-icon-divider" />

        <button
          type="button"
          class="tian-annotate-icon-btn"
          :class="{ 'is-success': copyState === 'copied' }"
          :disabled="!filteredAnnotations.length"
          aria-label="Copy markdown"
          :title="copyState === 'copied' ? 'Copied!' : 'Copy markdown'"
          @click="copyMarkdown"
        >
          <Transition name="tian-icon-pop" mode="out-in">
            <svg
              v-if="copyState === 'copied'"
              key="check"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <svg
              v-else
              key="copy"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          </Transition>
        </button>

        <button
          type="button"
          class="tian-annotate-icon-btn"
          :class="{ 'is-success': clearState === 'cleared' }"
          :disabled="!annotations.length"
          aria-label="Clear all annotations"
          :title="clearState === 'cleared' ? 'Cleared!' : 'Clear all annotations'"
          @click="handleClearAll"
        >
          <Transition name="tian-icon-pop" mode="out-in">
            <svg
              v-if="clearState === 'cleared'"
              key="check"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <svg
              v-else
              key="trash"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path
                d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"
              />
            </svg>
          </Transition>
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
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0A1.65 1.65 0 009.5 4.09V4a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82h0c.27.63.85 1.07 1.51 1.07H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
            />
          </svg>
        </button>

        <button
          type="button"
          class="tian-annotate-icon-btn"
          aria-label="Exit annotation mode"
          title="Exit annotation mode"
          @click="toggleActive"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </Transition>
  </div>

  <Transition name="tian-tag">
    <div
      v-if="active && hoverTarget && !pendingPick.el && !selectedAnnotation"
      class="tian-annotate-tag tian-annotate-ignore"
      :style="{ left: mouseX + 14 + 'px', top: mouseY + 14 + 'px' }"
    >
      {{
        mode === 'placement'
          ? 'Click to place'
          : mode === 'rearrange'
            ? 'Drag to move'
            : describeElement(hoverTarget)
      }}
      <span v-if="precise" class="tian-annotate-tag-hint"> · precise (Alt)</span>
      <span v-if="mode === 'feedback' && !precise" class="tian-annotate-tag-hint">
        · Shift+drag or Shift+click to multi-select</span
      >
    </div>
  </Transition>

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

  <!-- rearrange arrow -->
  <svg
    v-if="rearrangeArrow"
    class="tian-annotate-rearrange-arrow tian-annotate-ignore"
  >
    <defs>
      <marker
        id="tian-annotate-arrow-head"
        markerWidth="8"
        markerHeight="8"
        refX="6"
        refY="4"
        orient="auto"
      >
        <path d="M0,0 L8,4 L0,8 Z" fill="#8b5cf6" />
      </marker>
    </defs>
    <line
      :x1="rearrangeArrow.x1"
      :y1="rearrangeArrow.y1"
      :x2="rearrangeArrow.x2"
      :y2="rearrangeArrow.y2"
      stroke="#8b5cf6"
      stroke-width="2"
      stroke-dasharray="6 4"
      marker-end="url(#tian-annotate-arrow-head)"
    />
    <circle :cx="rearrangeArrow.x1" :cy="rearrangeArrow.y1" r="4" fill="#8b5cf6" />
  </svg>

  <!-- Feedback popup -->
  <Transition name="tian-fade-scale">
    <div
      v-if="
        (pendingPick.el && mode === 'feedback') ||
        (pendingPick.isMultiSelect &&
          !pendingPick.el &&
          pendingPick.rearrangeOriginalRect &&
          mode === 'feedback')
      "
      class="tian-annotate-popup tian-annotate-ignore"
      :style="{ left: pendingPick.x + 'px', top: pendingPick.y + 'px' }"
    >
      <div v-if="pendingPick.isMultiSelect && !pendingPick.el" class="tian-annotate-popup-title">
        Area annotation ({{ pendingPick.rearrangeOriginalRect!.width }}×{{
          pendingPick.rearrangeOriginalRect!.height
        }}px)
      </div>
      <div v-else-if="pendingPick.isMultiSelect" class="tian-annotate-popup-title">
        Multi-select ({{ pendingPick.nearbyElements.split(', ').length }} elements)
      </div>
      <div v-else class="tian-annotate-popup-title">
        {{
          pendingPick.selectedText
            ? `Selected: "${pendingPick.selectedText.slice(0, 40)}${pendingPick.selectedText.length > 40 ? '…' : ''}"`
            : pendingPick.el
              ? describeElement(pendingPick.el)
              : ''
        }}
      </div>
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
        <button type="button" :disabled="!pendingPick.comment.trim()" @click="confirmPick">
          Add
        </button>
      </div>
    </div>
  </Transition>

  <!-- Placement popup -->
  <Transition name="tian-fade-scale">
    <div
      v-if="pendingPick.el && mode === 'placement'"
      class="tian-annotate-popup tian-annotate-ignore"
      :style="{ left: pendingPick.x + 'px', top: pendingPick.y + 'px' }"
    >
      <div class="tian-annotate-popup-title">Place a new component</div>
      <input
        v-model="pendingPick.componentType"
        class="tian-annotate-input"
        list="tian-annotate-component-palette"
        placeholder="Component type (e.g. Button, Card)"
        autofocus
      />
      <datalist id="tian-annotate-component-palette">
        <option v-for="c in COMPONENT_PALETTE" :key="c" :value="c" />
      </datalist>
      <div class="tian-annotate-popup-row">
        <input
          v-model.number="pendingPick.placementWidth"
          class="tian-annotate-input"
          type="number"
          placeholder="Width"
        />
        <input
          v-model.number="pendingPick.placementHeight"
          class="tian-annotate-input"
          type="number"
          placeholder="Height"
        />
      </div>
      <input
        v-model="pendingPick.placementText"
        class="tian-annotate-input"
        placeholder="Suggested text (optional)"
      />
      <div class="tian-annotate-popup-row">
        <label style="font-size: 11px; color: inherit; align-self: center"
          >Scroll Y: {{ Math.round(pendingPick.y) }}px</label
        >
      </div>
      <textarea v-model="pendingPick.comment" rows="2" placeholder="Why place it here?" />
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
        <button
          type="button"
          :disabled="!pendingPick.comment.trim() || !pendingPick.componentType.trim()"
          @click="confirmPick"
        >
          Add
        </button>
      </div>
    </div>
  </Transition>

  <!-- Rearrange popup -->
  <Transition name="tian-fade-scale">
    <div
      v-if="pendingPick.el && mode === 'rearrange' && pendingPick.rearrangeOriginalRect"
      class="tian-annotate-popup tian-annotate-ignore"
      :style="{ left: pendingPick.x + 'px', top: pendingPick.y + 'px' }"
    >
      <div class="tian-annotate-popup-title">Move: {{ pendingPick.rearrangeLabel }}</div>
      <div style="font-size: 11px; margin-bottom: 6px">
        From {{ pendingPick.rearrangeOriginalRect.x }},{{ pendingPick.rearrangeOriginalRect.y }} →
        {{ pendingPick.rearrangeCurrentRect?.x }},{{ pendingPick.rearrangeCurrentRect?.y }}
      </div>
      <textarea v-model="pendingPick.comment" rows="2" placeholder="Why move this?" autofocus />
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
        <button type="button" :disabled="!pendingPick.comment.trim()" @click="confirmPick">
          Add
        </button>
      </div>
    </div>
  </Transition>

  <!-- Detail popup (view/edit annotation) -->
  <Teleport to="body">
    <Transition name="tian-overlay">
      <div
        v-if="selectedAnnotation"
        class="tian-annotate-detail-overlay tian-annotate-ignore"
        @click.self="closeDetail"
      >
        <div class="tian-annotate-detail tian-annotate-ignore">
          <div class="tian-annotate-detail-header">
            <div class="tian-annotate-detail-header-title">
              <span class="tian-annotate-detail-index"
                >#{{ annotations.findIndex((a) => a.id === selectedAnnotation!.id) + 1 }}</span
              >
              <span
                :class="`tian-annotate-status tian-annotate-status--${selectedAnnotation.status}`"
                >{{ selectedAnnotation.status }}</span
              >
            </div>
            <button
              type="button"
              class="tian-annotate-icon-close"
              aria-label="Close"
              @click="closeDetail"
            >
              &times;
            </button>
          </div>

          <div class="tian-annotate-detail-body">
            <div class="tian-annotate-field">
              <span class="tian-annotate-field-label">Element</span>
              <span class="tian-annotate-field-value tian-annotate-mono">{{
                selectedAnnotation.element
              }}</span>
            </div>

            <div class="tian-annotate-field">
              <div class="tian-annotate-field-label-row">
                <span class="tian-annotate-field-label">Comment</span>
                <button
                  v-if="!editingComment"
                  type="button"
                  class="tian-annotate-link-btn"
                  :disabled="selectedAnnotation.status === 'resolved' || !!dispatching"
                  @click="startEditComment"
                >
                  Edit
                </button>
              </div>
              <p v-if="!editingComment" class="tian-annotate-field-value">
                {{ selectedAnnotation.comment }}
              </p>
              <template v-else>
                <textarea
                  v-model="editCommentText"
                  class="tian-annotate-textarea"
                  rows="3"
                  :disabled="!!dispatching"
                />
                <div class="tian-annotate-detail-field-actions">
                  <button
                    type="button"
                    class="tian-annotate-btn-ghost-sm"
                    @click="cancelEditComment"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="tian-annotate-btn-sm"
                    :disabled="!editCommentText.trim()"
                    @click="saveEditComment"
                  >
                    Save
                  </button>
                </div>
              </template>
            </div>

            <div v-if="selectedAnnotation.selectedText" class="tian-annotate-field">
              <span class="tian-annotate-field-label">Selected text</span>
              <p class="tian-annotate-field-value tian-annotate-field-value--quote">
                "{{ selectedAnnotation.selectedText }}"
              </p>
            </div>

            <div
              v-if="selectedAnnotation.intent || selectedAnnotation.severity"
              class="tian-annotate-field-row"
            >
              <div v-if="selectedAnnotation.intent" class="tian-annotate-field">
                <span class="tian-annotate-field-label">Intent</span>
                <span class="tian-annotate-field-value">{{ selectedAnnotation.intent }}</span>
              </div>
              <div v-if="selectedAnnotation.severity" class="tian-annotate-field">
                <span class="tian-annotate-field-label">Severity</span>
                <span class="tian-annotate-field-value">{{ selectedAnnotation.severity }}</span>
              </div>
            </div>
          </div>

          <!-- Agent sync + dispatch -->
          <div v-if="syncEnabled" class="tian-annotate-agent-block">
            <div class="tian-annotate-agent-sync">
              <span class="tian-annotate-agent-sync-dot"></span>
              <span class="tian-annotate-agent-sync-text">
                Synced to {{ syncEndpointHost
                }}<template v-if="selectedAnnotation.updatedAt">
                  · {{ formatRelativeTime(selectedAnnotation.updatedAt) }}</template
                >
              </span>
              <button type="button" class="tian-annotate-link-btn" @click="syncNow">
                Sync now
              </button>
            </div>
            <div class="tian-annotate-dispatch-row">
              <button
                type="button"
                class="tian-annotate-btn-dispatch tian-annotate-btn-dispatch--icon"
                :class="{ 'is-loading': dispatching === 'claude', 'is-default': defaultAgent === 'claude' }"
                :disabled="!!dispatching || selectedAnnotation.status === 'resolved'"
                :aria-label="dispatching === 'claude' ? 'Starting Claude…' : 'Fix with Claude'"
                :title="dispatching === 'claude' ? 'Starting Claude…' : 'Fix with Claude'"
                @click="runAgent('claude')"
              >
                <span v-if="dispatching === 'claude'" class="tian-annotate-spinner"></span>
                <span v-else class="tian-annotate-dispatch-icon" v-html="claudeLogo"></span>
              </button>
              <button
                type="button"
                class="tian-annotate-btn-dispatch tian-annotate-btn-dispatch--icon"
                :class="{ 'is-loading': dispatching === 'opencode', 'is-default': defaultAgent === 'opencode' }"
                :disabled="!!dispatching || selectedAnnotation.status === 'resolved'"
                :aria-label="
                  dispatching === 'opencode' ? 'Starting OpenCode…' : 'Fix with OpenCode'
                "
                :title="dispatching === 'opencode' ? 'Starting OpenCode…' : 'Fix with OpenCode'"
                @click="runAgent('opencode')"
              >
                <span v-if="dispatching === 'opencode'" class="tian-annotate-spinner"></span>
                <span v-else class="tian-annotate-dispatch-icon" v-html="opencodeLogo"></span>
              </button>
            </div>
            <p v-if="dispatchError" class="tian-annotate-dispatch-error">{{ dispatchError }}</p>
          </div>

          <!-- Thread -->
          <div class="tian-annotate-detail-section">
            <span class="tian-annotate-field-label">Thread</span>
            <Transition name="tian-thread-appear">
              <div v-if="selectedAnnotation.thread?.length" class="tian-annotate-thread-messages">
                <div
                  v-for="msg in selectedAnnotation.thread"
                  :key="msg.id"
                  class="tian-annotate-thread-msg"
                  :class="[
                    `tian-annotate-thread-msg--${msg.role}`,
                    { 'tian-annotate-thread-msg--log': msg.content.includes('\n') },
                  ]"
                >
                  <span
                    class="tian-annotate-thread-role"
                    :class="`tian-annotate-thread-role--${msg.role}`"
                    >{{ msg.role }}</span
                  >
                  <span class="tian-annotate-thread-content">{{ msg.content }}</span>
                </div>
                <div v-if="agentRunStatus" class="tian-annotate-thread-running">
                  <span class="tian-annotate-spinner"></span>
                  <span>{{ agentRunStatus.agent }} is running…</span>
                </div>
              </div>
              <div v-else-if="agentRunStatus" class="tian-annotate-thread-messages">
                <div class="tian-annotate-thread-running">
                  <span class="tian-annotate-spinner"></span>
                  <span>{{ agentRunStatus.agent }} is running…</span>
                </div>
              </div>
            </Transition>
          </div>

          <!-- Actions -->
          <div class="tian-annotate-detail-actions">
            <button
              type="button"
              class="tian-annotate-btn-danger-ghost"
              @click="deleteAnnotation(selectedAnnotation.id)"
            >
              Delete
            </button>
            <div class="tian-annotate-detail-actions-main">
              <button
                v-if="
                  selectedAnnotation.status !== 'acknowledged' &&
                  selectedAnnotation.status !== 'resolved' &&
                  selectedAnnotation.status !== 'dismissed'
                "
                type="button"
                class="tian-annotate-btn-outline tian-annotate-btn-outline--amber"
                @click="markStatus(selectedAnnotation.id, 'acknowledged')"
              >
                Acknowledge
              </button>
              <button
                v-if="selectedAnnotation.status !== 'resolved'"
                type="button"
                class="tian-annotate-btn-primary"
                @click="markStatus(selectedAnnotation.id, 'resolved')"
              >
                Mark resolved
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- Pins -->
  <Teleport to="body">
    <template v-if="pinsVisible">
      <div
        v-for="(a, i) in filteredAnnotations"
        :key="a.id"
        :class="[pinClass(a), 'tian-annotate-ignore']"
        :style="pinStyle(a)"
        :title="`#${i + 1}: ${a.comment}`"
        @click.stop="selectAnnotation(a)"
      >
        <template v-if="a.kind === 'placement'">+</template>
        <span
          v-else-if="a.kind === 'rearrange'"
          class="tian-annotate-pin-icon"
          v-html="arrangeIcon"
        ></span>
        <template v-else-if="a.kind === 'area'">▦</template>
        <template v-else>{{ i + 1 }}</template>
      </div>
    </template>
  </Teleport>
</template>

<style>
.tian-annotate-hover-outline {
  outline: 2px solid var(--tian-accent) !important;
  outline-offset: 1px !important;
  cursor: crosshair !important;
  transition: outline-color 80ms ease-out;
}

.tian-annotate-multiselect-item-outline {
  outline: 2px dashed var(--tian-accent) !important;
  outline-offset: 1px !important;
  pointer-events: none;
}

/* Applied while a Shift+drag marquee select is in progress, so the browser's
   native text-selection doesn't race our own drag-rect highlight. */
html.tian-annotate-no-select,
html.tian-annotate-no-select * {
  user-select: none !important;
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
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}
.tian-annotate-toggle-icon {
  display: inline-flex;
  width: 22px;
  height: 22px;
}
.tian-annotate-toggle-icon svg {
  width: 100%;
  height: 100%;
  fill: currentColor;
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
  background: var(--tian-accent);
  color: #fff;
}
.tian-annotate-icon-btn.is-success {
  color: #22c55e;
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
  background: rgba(20, 20, 23, 0.96);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
  font-size: 13px;
  color: #fafafa;
  width: 260px;
}
.tian-annotate-panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.tian-annotate-panel-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.tian-annotate-panel-count {
  font-size: 11px;
  color: #a1a1aa;
}
.tian-annotate-panel-section {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 10px;
}
.tian-annotate-panel-section:last-child {
  margin-bottom: 0;
}
.tian-annotate-panel-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #a1a1aa;
  margin-bottom: 8px;
}
.tian-annotate-panel-refresh {
  border: none;
  background: transparent;
  color: #a1a1aa;
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
}
.tian-annotate-panel-refresh:hover:not(:disabled) {
  color: #fafafa;
}
.tian-annotate-panel-refresh:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.tian-annotate-panel-hint {
  font-size: 10.5px;
  color: #71717a;
  line-height: 1.4;
}
.tian-annotate-panel-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 10px 0;
}
.tian-annotate-panel-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: #d4d4d8;
}
.tian-annotate-panel-label-icon {
  display: inline-flex;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.tian-annotate-panel-label-icon svg {
  width: 100%;
  height: 100%;
}
.tian-annotate-panel-select {
  width: 100%;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: #fafafa;
  cursor: pointer;
  font-family: inherit;
}
.tian-annotate-panel-select:focus {
  outline: none;
  border-color: var(--tian-accent);
  background: rgba(255, 255, 255, 0.09);
}
.tian-annotate-panel-input {
  cursor: text;
}
.tian-annotate-panel-input::placeholder {
  color: #71717a;
}
.tian-annotate-panel select option {
  color: #18181b;
}
.tian-annotate-panel-color {
  width: 32px;
  height: 28px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  padding: 2px;
}
.tian-annotate-panel-check {
  width: 16px;
  height: 16px;
  accent-color: var(--tian-accent);
  cursor: pointer;
}
.tian-annotate-panel-range {
  width: 120px;
  accent-color: var(--tian-accent);
  cursor: pointer;
}
.tian-annotate-wireframe-overlay {
  position: fixed;
  inset: 0;
  z-index: 999990;
  pointer-events: none;
  backdrop-filter: grayscale(1) contrast(0.4);
  -webkit-backdrop-filter: grayscale(1) contrast(0.4);
}
.tian-annotate-wireframe-grid {
  position: fixed;
  inset: 0;
  z-index: 999991;
  pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(99, 102, 241, 0.35) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(99, 102, 241, 0.35) 1px, transparent 1px);
}
.tian-annotate-wireframe-ruler-top,
.tian-annotate-wireframe-ruler-left {
  position: fixed;
  z-index: 999992;
  pointer-events: none;
  background: rgba(24, 24, 27, 0.85);
}
.tian-annotate-wireframe-ruler-top {
  top: 0;
  left: 0;
  right: 0;
  height: 16px;
  border-bottom: 1px solid rgba(99, 102, 241, 0.5);
}
.tian-annotate-wireframe-ruler-left {
  top: 0;
  left: 0;
  bottom: 0;
  width: 32px;
  border-right: 1px solid rgba(99, 102, 241, 0.5);
}
.tian-annotate-wireframe-tick-x {
  position: absolute;
  top: 2px;
  transform: translateX(-50%);
  font-size: 9px;
  font-family: monospace;
  color: #a5b4fc;
  white-space: nowrap;
}
.tian-annotate-wireframe-tick-y {
  position: absolute;
  left: 2px;
  transform: translateY(-50%);
  font-size: 9px;
  font-family: monospace;
  color: #a5b4fc;
  white-space: nowrap;
}
.tian-annotate-btn-ghost {
  background: transparent !important;
}

.tian-annotate-pin {
  position: absolute;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--tian-accent);
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
.tian-annotate-pin--acknowledged {
  background: #f59e0b;
}
.tian-annotate-pin--resolved {
  background: #6b7280;
  opacity: 0.6;
}
.tian-annotate-pin--placement {
  background: #10b981;
  border-radius: 4px;
  font-size: 16px;
  width: 24px;
  height: 24px;
}
.tian-annotate-pin--rearrange {
  background: #8b5cf6;
  border-radius: 4px;
  font-size: 14px;
  width: 24px;
  height: 24px;
}
.tian-annotate-pin-icon {
  display: inline-flex;
  width: 14px;
  height: 14px;
}
.tian-annotate-pin-icon svg {
  width: 100%;
  height: 100%;
}
.tian-annotate-pin-icon svg path {
  fill: #fff;
}
.tian-annotate-pin--area {
  background: #f59e0b;
  font-size: 14px;
  width: 26px;
  height: 26px;
}

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
  background: var(--tian-accent);
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
  border: 2px dashed var(--tian-accent);
  background: rgba(99, 102, 241, 0.08);
  pointer-events: none;
}

.tian-annotate-multiselect-overlay {
  position: fixed;
  z-index: 999997;
  border: 2px dashed var(--tian-accent);
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.12);
  pointer-events: none;
}

.tian-annotate-rearrange-ghost {
  position: fixed;
  z-index: 999997;
  pointer-events: none;
  opacity: 0.65;
  outline: 2px dashed #8b5cf6;
  outline-offset: 2px;
  border-radius: 4px;
  transition: none;
  overflow: hidden;
}

.tian-annotate-rearrange-ghost--dropped {
  opacity: 0.3;
  transition: opacity 0.15s ease;
}

.tian-annotate-rearrange-arrow {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 999995;
  pointer-events: none;
  overflow: visible;
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
  border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.16);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
  color: #18181b;
  width: 380px;
  max-height: 80vh;
  overflow-y: auto;
}
.tian-annotate-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 12px 14px 16px;
  border-bottom: 1px solid #e4e4e7;
  position: sticky;
  top: 0;
  background: inherit;
}
.tian-annotate-detail-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tian-annotate-detail-index {
  font-weight: 600;
  font-size: 13px;
  color: #3f3f46;
}
.tian-annotate-icon-close {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: #71717a;
  font-size: 16px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.tian-annotate-icon-close:hover {
  background: #f4f4f5;
  color: #18181b;
}

.tian-annotate-detail-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}
.tian-annotate-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.tian-annotate-field-row {
  display: flex;
  gap: 20px;
}
.tian-annotate-field-row .tian-annotate-field {
  flex: 1;
}
.tian-annotate-field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tian-annotate-field-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #a1a1aa;
}
.tian-annotate-field-value {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: #18181b;
  word-break: break-word;
  text-transform: capitalize;
}
.tian-annotate-field-value--quote {
  font-style: italic;
  color: #52525b;
  text-transform: none;
}
.tian-annotate-mono {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  text-transform: none;
}

.tian-annotate-link-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--tian-accent);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
.tian-annotate-link-btn:hover {
  text-decoration: underline;
}

.tian-annotate-detail-field-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  margin-top: 4px;
}
.tian-annotate-textarea {
  width: 100%;
  font-size: 12.5px;
  font-family: inherit;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid #d4d4d8;
  background: transparent;
  color: inherit;
  resize: vertical;
}
.tian-annotate-textarea:focus {
  outline: none;
  border-color: var(--tian-accent);
}
.tian-annotate-btn-ghost-sm {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid #d4d4d8;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.tian-annotate-detail-section {
  padding: 12px 16px;
  border-top: 1px solid #e4e4e7;
}
.tian-annotate-detail-actions {
  padding: 12px 16px;
  border-top: 1px solid #e4e4e7;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tian-annotate-detail-actions-main {
  display: flex;
  gap: 8px;
}

.tian-annotate-status {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  padding: 3px 9px;
  border-radius: 999px;
}
.tian-annotate-status--pending {
  background: #e0e7ff;
  color: #4338ca;
}
.tian-annotate-status--acknowledged {
  background: #fef3c7;
  color: #b45309;
}
.tian-annotate-status--resolved {
  background: #dcfce7;
  color: #15803d;
}
.tian-annotate-status--dismissed {
  background: #f4f4f5;
  color: #71717a;
}

.tian-annotate-agent-block {
  padding: 10px 16px;
  background: #fafafa;
  border-top: 1px solid #e4e4e7;
  border-bottom: 1px solid #e4e4e7;
}
.tian-annotate-agent-sync {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: #52525b;
}
.tian-annotate-dispatch-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.tian-annotate-btn-dispatch {
  flex: 1;
  font-size: 11.5px;
  font-weight: 600;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid #d4d4d8;
  background: #fff;
  color: #18181b;
  cursor: pointer;
}
.tian-annotate-btn-dispatch:hover:not(:disabled) {
  border-color: var(--tian-accent);
  color: #4f46e5;
}
.tian-annotate-btn-dispatch:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.tian-annotate-btn-dispatch--icon {
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tian-annotate-btn-dispatch--icon .tian-annotate-spinner {
  margin-right: 0;
}
.tian-annotate-dispatch-icon {
  display: inline-flex;
  width: 16px;
  height: 16px;
}
.tian-annotate-dispatch-icon svg {
  width: 100%;
  height: 100%;
}
.tian-annotate-dispatch-error {
  margin: 6px 0 0;
  font-size: 11px;
  color: #b91c1c;
}
.tian-annotate-agent-sync-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.15);
  flex-shrink: 0;
}
.tian-annotate-agent-sync-text {
  flex: 1;
  min-width: 0;
}

.tian-annotate-thread-messages {
  max-height: 160px;
  overflow-y: auto;
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tian-annotate-thread-msg {
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.45;
}
.tian-annotate-thread-msg--human {
  background: #f4f4f9;
}
.tian-annotate-thread-msg--agent {
  background: #f2faf5;
}
.tian-annotate-thread-role {
  display: inline-block;
  font-weight: 700;
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.03em;
  padding: 1px 6px;
  border-radius: 999px;
  margin-right: 6px;
  vertical-align: middle;
}
.tian-annotate-thread-role--human {
  background: #e0e7ff;
  color: #4338ca;
}
.tian-annotate-thread-role--agent {
  background: #dcfce7;
  color: #15803d;
}
.tian-annotate-thread-content {
  word-break: break-word;
  color: #27272a;
  white-space: pre-wrap;
}
.tian-annotate-thread-msg--log .tian-annotate-thread-content {
  display: block;
  margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
}
.tian-annotate-thread-running {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: #4338ca;
  background: #eef2ff;
}
.tian-annotate-thread-running .tian-annotate-spinner {
  border-color: rgba(67, 56, 202, 0.25);
  border-top-color: #4338ca;
}
.tian-annotate-btn-sm {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 6px;
  border: none;
  background: var(--tian-accent);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
}
.tian-annotate-btn-sm:hover:not(:disabled) {
  background: #4f46e5;
}
.tian-annotate-btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tian-annotate-btn-primary {
  font-size: 12.5px;
  font-weight: 600;
  padding: 7px 14px;
  border-radius: 8px;
  border: none;
  background: var(--tian-accent);
  color: #fff;
  cursor: pointer;
}
.tian-annotate-btn-primary:hover {
  background: #4f46e5;
}

.tian-annotate-btn-outline {
  font-size: 12.5px;
  font-weight: 600;
  padding: 7px 14px;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.tian-annotate-btn-outline--amber {
  border: 1px solid #fbbf24;
  color: #b45309;
}
.tian-annotate-btn-outline--amber:hover {
  background: #fffbeb;
}

.tian-annotate-btn-danger-ghost {
  font-size: 12.5px;
  font-weight: 600;
  padding: 7px 10px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #ef4444;
  cursor: pointer;
}
.tian-annotate-btn-danger-ghost:hover {
  background: #fef2f2;
}

/* ---- Transitions ---- */

/* Icon swap inside toolbar buttons (e.g. copy/trash -> check on success) */
.tian-icon-pop-enter-active,
.tian-icon-pop-leave-active {
  transition:
    opacity 110ms ease-out,
    transform 110ms ease-out;
}
.tian-icon-pop-enter-from {
  opacity: 0;
  transform: scale(0.5);
}
.tian-icon-pop-leave-to {
  opacity: 0;
  transform: scale(0.5);
}

/* Tooltip hover tag */
.tian-tag-enter-active,
.tian-tag-leave-active {
  transition:
    opacity 100ms ease-out,
    transform 100ms ease-out;
}
.tian-tag-enter-from,
.tian-tag-leave-to {
  opacity: 0;
  transform: translateY(2px) scale(0.97);
}

/* Toolbar: "+" toggle <-> pill icon bar */
.tian-toolbar-enter-active,
.tian-toolbar-leave-active {
  transition:
    opacity 130ms ease-out,
    transform 130ms ease-out;
}
.tian-toolbar-enter-from,
.tian-toolbar-leave-to {
  opacity: 0;
  transform: scale(0.85);
}

/* Settings panel */
.tian-panel-enter-active,
.tian-panel-leave-active {
  transition:
    opacity 120ms ease-out,
    transform 120ms ease-out;
  transform-origin: top;
}
.tian-panel-enter-from,
.tian-panel-leave-to {
  opacity: 0;
  transform: translateY(-4px) scaleY(0.96);
}

/* Thread messages / running indicator appearing in the detail modal */
.tian-thread-appear-enter-active,
.tian-thread-appear-leave-active {
  transition:
    opacity 140ms ease-out,
    transform 140ms ease-out;
  transform-origin: top;
}
.tian-thread-appear-enter-from,
.tian-thread-appear-leave-to {
  opacity: 0;
  transform: translateY(-4px) scaleY(0.97);
}

/* Shared fade+scale for popups */
.tian-fade-scale-enter-active,
.tian-fade-scale-leave-active {
  transition:
    opacity 130ms ease-out,
    transform 130ms ease-out;
}
.tian-fade-scale-enter-from,
.tian-fade-scale-leave-to {
  opacity: 0;
  transform: scale(0.96);
}

/* Overlay backdrop (detail modal) */
.tian-overlay-enter-active {
  transition: opacity 100ms ease-out;
}
.tian-overlay-leave-active {
  transition: opacity 80ms ease-out;
}
.tian-overlay-enter-from,
.tian-overlay-leave-to {
  opacity: 0;
}
.tian-overlay-enter-active .tian-annotate-detail {
  transition:
    opacity 130ms ease-out 30ms,
    transform 130ms ease-out 30ms;
}
.tian-overlay-leave-active .tian-annotate-detail {
  transition:
    opacity 100ms ease-out,
    transform 100ms ease-out;
}
.tian-overlay-enter-from .tian-annotate-detail,
.tian-overlay-leave-to .tian-annotate-detail {
  opacity: 0;
  transform: scale(0.96);
}

/* ---- Spinner ---- */
@keyframes tian-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.tian-annotate-spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 2px solid rgba(0, 0, 0, 0.15);
  border-top-color: #18181b;
  border-radius: 50%;
  animation: tian-spin 0.6s linear infinite;
  margin-right: 4px;
  vertical-align: -2px;
}

/* Loading state for dispatch buttons */
.tian-annotate-btn-dispatch.is-loading {
  border-color: var(--tian-accent);
  background: #eef2ff;
  color: #4f46e5;
}
.tian-annotate-btn-dispatch.is-loading .tian-annotate-spinner {
  border-color: rgba(79, 70, 229, 0.2);
  border-top-color: #4f46e5;
}
.tian-annotate-btn-dispatch.is-default {
  border-color: var(--tian-accent);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}
.tian-annotate-btn-dispatch.is-default:hover:not(:disabled) {
  border-color: var(--tian-accent);
  background: #eef2ff;
}

/* Disabled link button */
.tian-annotate-link-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  text-decoration: none !important;
}
</style>
