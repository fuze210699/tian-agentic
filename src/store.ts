import { reactive, computed, watch } from 'vue';
import type { Annotation, ThreadMessage } from './types';

const annotations = reactive<Annotation[]>([]);

let counter = 0;
function nextId(): string {
  counter += 1;
  return `ann_${Date.now().toString(36)}${counter}`;
}

let persistKey: string | null = null;

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
  } catch { /* ignore corrupt data */ }
}

function saveToStorage() {
  if (!persistKey) return;
  try {
    localStorage.setItem(persistKey, JSON.stringify(annotations));
  } catch { /* ignore quota errors */ }
}

let saveWatcher: ReturnType<typeof watch> | null = null;

export function useTianAnnotateStore(persistKeyProp?: string) {
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

  function addAnnotation(
    data: Omit<Annotation, 'id' | 'timestamp' | 'status'> & { status?: Annotation['status'] }
  ): Annotation {
    const annotation: Annotation = {
      id: nextId(),
      timestamp: Date.now(),
      status: 'pending',
      ...data,
    };
    annotations.push(annotation);
    return annotation;
  }

  function updateAnnotation(id: string, patch: Partial<Annotation>) {
    const found = annotations.find((a) => a.id === id);
    if (found) Object.assign(found, patch);
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
  }

  function clearAll() {
    annotations.splice(0, annotations.length);
  }

  function addThreadMessage(id: string, message: Omit<ThreadMessage, 'id' | 'timestamp'>) {
    const found = annotations.find((a) => a.id === id);
    if (!found) return;
    if (!found.thread) found.thread = [];
    found.thread.push({
      id: nextId(),
      timestamp: Date.now(),
      ...message,
    });
  }

  const pending = computed(() => annotations.filter((a) => a.status === 'pending'));

  return { annotations, pending, addAnnotation, updateAnnotation, setStatus, removeAnnotation, clearAll, addThreadMessage };
}
