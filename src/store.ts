import { reactive, computed, watch } from 'vue';
import type { Annotation } from './types';
import { syncCreate, syncUpdate, syncDelete, fetchAnnotations } from './sync';

const annotations = reactive<Annotation[]>([]);

let counter = 0;
function nextId(): string {
  counter += 1;
  return `ann_${Date.now().toString(36)}${counter}`;
}

let persistKey: string | null = null;

// Best-effort bridge to a tian-agentic-be instance — see sync.ts. Disabled
// (both vars null/default) unless a host app passes `syncEndpoint`, so the
// zero-backend default behavior is unchanged for everyone else.
let syncEndpoint: string | null = null;
let syncSessionId = 'default';
let syncPollHandle: ReturnType<typeof setInterval> | null = null;

// Ids we know for certain reached the backend (syncCreate resolved ok) — an
// id only becomes eligible for the "remote deleted it, remove locally too"
// check below once it's in here. Without this, a poll tick landing in the
// gap between `annotations.push(...)` and its in-flight POST finishing would
// see the new annotation missing from the backend's response and delete it
// locally before the create even arrived — a false positive, not a real
// server-side delete.
const confirmedSynced = new Set<string>();

async function pollSync() {
  if (!syncEndpoint) return;
  const remote = await fetchAnnotations(syncEndpoint, syncSessionId);
  const remoteIds = new Set(remote.map((r) => r.id));
  for (const r of remote) {
    const local = annotations.find((a) => a.id === r.id);
    // v1: only merge annotations the browser already knows about (created
    // locally then pushed) — never adopt server-only records, to avoid
    // duplicating/inventing annotations the user never made on this page.
    if (!local) continue;
    if (r.status && r.status !== local.status) local.status = r.status;
    if (r.resolvedAt && r.resolvedAt !== local.resolvedAt) local.resolvedAt = r.resolvedAt;
    if (r.resolvedBy && r.resolvedBy !== local.resolvedBy) local.resolvedBy = r.resolvedBy;
    if (r.thread && r.thread.length !== (local.thread?.length || 0)) local.thread = r.thread;
    if (r.updatedAt) local.updatedAt = r.updatedAt;
  }

  // Mirror server-side deletes (e.g. an agent calling tian_annotate_delete)
  // back into the local list, so the pin actually disappears here too.
  for (let i = annotations.length - 1; i >= 0; i--) {
    const id = annotations[i].id;
    if (confirmedSynced.has(id) && !remoteIds.has(id)) {
      annotations.splice(i, 1);
      confirmedSynced.delete(id);
    }
  }
}

function loadFromStorage() {
  if (!persistKey) return;
  try {
    const raw = localStorage.getItem(persistKey);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        annotations.splice(0, annotations.length, ...data);
      }
    }
  } catch {
    /* ignore corrupt data */
  }
}

function saveToStorage() {
  if (!persistKey) return;
  try {
    localStorage.setItem(persistKey, JSON.stringify(annotations));
  } catch {
    /* ignore quota errors */
  }
}

let saveWatcher: ReturnType<typeof watch> | null = null;

export function useTianAnnotateStore(
  persistKeyProp?: string,
  syncOptions?: { endpoint?: string; sessionId?: string }
) {
  if (persistKeyProp && persistKeyProp !== persistKey) {
    persistKey = persistKeyProp;
    loadFromStorage();
    if (!saveWatcher) {
      saveWatcher = watch(
        () => [...annotations],
        () => saveToStorage(),
        { deep: true }
      );
    }
  }

  if (syncOptions?.endpoint) syncEndpoint = syncOptions.endpoint;
  if (syncOptions?.sessionId) syncSessionId = syncOptions.sessionId;

  function addAnnotation(
    data: Omit<Annotation, 'id' | 'timestamp' | 'status'> & { status?: Annotation['status'] }
  ): Annotation {
    const annotation: Annotation = {
      id: nextId(),
      timestamp: Date.now(),
      status: 'pending',
      sessionId: syncSessionId,
      ...data,
    };
    annotations.push(annotation);
    if (syncEndpoint) {
      syncCreate(syncEndpoint, annotation).then((ok) => {
        if (ok) confirmedSynced.add(annotation.id);
      });
    }
    return annotation;
  }

  function updateAnnotation(id: string, patch: Partial<Annotation>) {
    const found = annotations.find((a) => a.id === id);
    if (!found) return;
    Object.assign(found, patch);
    if (syncEndpoint) syncUpdate(syncEndpoint, id, patch);
  }

  function setStatus(id: string, status: Annotation['status']) {
    updateAnnotation(id, {
      status,
      resolvedAt: status === 'resolved' ? new Date().toISOString() : undefined,
    });
  }

  function removeAnnotation(id: string) {
    const i = annotations.findIndex((a) => a.id === id);
    if (i !== -1) annotations.splice(i, 1);
    confirmedSynced.delete(id);
    if (syncEndpoint) syncDelete(syncEndpoint, id);
  }

  function clearAll() {
    annotations.splice(0, annotations.length);
  }

  function startSync(intervalMs = 3000) {
    if (!syncEndpoint || syncPollHandle) return;
    syncPollHandle = setInterval(pollSync, intervalMs);
    pollSync();
  }

  function stopSync() {
    if (syncPollHandle) {
      clearInterval(syncPollHandle);
      syncPollHandle = null;
    }
  }

  function syncNow() {
    return pollSync();
  }

  const syncEnabled = computed(() => !!syncEndpoint);
  const pending = computed(() => annotations.filter((a) => a.status === 'pending'));

  return {
    annotations,
    pending,
    addAnnotation,
    updateAnnotation,
    setStatus,
    removeAnnotation,
    clearAll,
    startSync,
    stopSync,
    syncNow,
    syncEnabled,
  };
}
