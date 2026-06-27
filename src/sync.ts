// src/sync.ts
//
// Best-effort HTTP bridge to a tian-agentic-be instance (see
// d:\project\tian-agentic-be). All functions swallow network errors — an
// unreachable/offline backend must never break local annotating, same
// philosophy as the localStorage persistence in store.ts.

import type { Annotation, ThreadMessage } from './types';

function url(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/$/, '')}${path}`;
}

export async function syncCreate(endpoint: string, annotation: Annotation): Promise<boolean> {
  try {
    const res = await fetch(url(endpoint, '/api/annotations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(annotation),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function syncUpdate(
  endpoint: string,
  id: string,
  patch: Partial<Annotation>
): Promise<void> {
  try {
    await fetch(url(endpoint, `/api/annotations/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {
    /* best-effort */
  }
}

export async function syncThreadMessage(
  endpoint: string,
  id: string,
  message: Omit<ThreadMessage, 'id' | 'timestamp'>
): Promise<void> {
  try {
    await fetch(url(endpoint, `/api/annotations/${id}/thread`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch {
    /* best-effort */
  }
}

export async function syncDelete(endpoint: string, id: string): Promise<void> {
  try {
    await fetch(url(endpoint, `/api/annotations/${id}`), { method: 'DELETE' });
  } catch {
    /* best-effort */
  }
}

export async function dispatchAgent(
  endpoint: string,
  id: string,
  agent: 'claude' | 'opencode',
  model?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url(endpoint, `/api/annotations/${id}/dispatch`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, model }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error || `Request failed (${res.status})` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function fetchAgentModels(
  endpoint: string,
  agent: 'claude' | 'opencode',
  sessionId: string
): Promise<{ models: string[]; error?: string }> {
  try {
    const res = await fetch(
      url(endpoint, `/api/models/${agent}?sessionId=${encodeURIComponent(sessionId)}`)
    );
    if (!res.ok) return { models: [], error: `Request failed (${res.status})` };
    const data = await res.json();
    return { models: Array.isArray(data?.models) ? data.models : [], error: data?.error };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function fetchAnnotations(
  endpoint: string,
  sessionId: string
): Promise<Annotation[]> {
  try {
    const res = await fetch(
      url(endpoint, `/api/annotations?sessionId=${encodeURIComponent(sessionId)}`)
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
