// src/types.ts
//
// The annotation schema this package reads and writes. An `Annotation` is
// a single piece of feedback attached to a UI element, with enough DOM and
// component context for an AI coding agent to locate and act on it.
//
// Field naming note: `reactComponents` holds the *Vue* component ancestry
// chain (e.g. "App > Dashboard > SubmitButton"), not a React fiber tree.
// The field is named generically rather than `vueComponents` so any tool
// consuming this output that looks for a "framework component tree" field
// under that key keeps working unchanged. See vueTree.ts for how the chain
// is built from Vue's instance tree.

export type ThreadMessage = {
  id: string;
  role: 'human' | 'agent';
  content: string;
  timestamp: number;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Annotation = {
  // Required
  id: string;
  comment: string;
  elementPath: string;
  timestamp: number;
  x: number; // % of viewport width (0-100)
  y: number; // px from document top (or viewport if isFixed)
  element: string; // tag name, e.g. "button"

  // Recommended
  url?: string;
  boundingBox?: Rect;

  // Optional context
  /** Vue component ancestry chain — see field naming note above. */
  reactComponents?: string;
  cssClasses?: string;
  computedStyles?: string;
  accessibility?: string;
  nearbyText?: string;
  selectedText?: string;

  // Browser component fields
  isFixed?: boolean;
  isMultiSelect?: boolean;
  fullPath?: string;
  nearbyElements?: string;

  // Feedback classification
  intent?: 'fix' | 'change' | 'question' | 'approve';
  severity?: 'blocking' | 'important' | 'suggestion';

  // Annotation kind (layout-mode fields are typed for forward-compatibility;
  // the UI currently only produces "feedback" kind annotations — see README)
  kind?: 'feedback' | 'placement' | 'rearrange' | 'area';

  placement?: {
    componentType: string;
    width: number;
    height: number;
    scrollY: number;
    text?: string;
  };

  rearrange?: {
    selector: string;
    label: string;
    tagName: string;
    originalRect: Rect;
    currentRect: Rect;
  };

  area?: {
    rect: Rect;
    scrollY: number;
  };

  // Lifecycle
  status?: 'pending' | 'acknowledged' | 'resolved' | 'dismissed';
  resolvedAt?: string;
  resolvedBy?: 'human' | 'agent';
  thread?: ThreadMessage[];

  // Server-added metadata (set when syncing, not by the browser component)
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AnnotationEvent = {
  type:
    | 'annotation.created'
    | 'annotation.updated'
    | 'annotation.deleted'
    | 'session.created'
    | 'session.updated'
    | 'session.closed'
    | 'thread.message'
    | 'action.requested';
  timestamp: string; // ISO 8601
  sessionId: string;
  sequence: number; // monotonic, for ordering/replay
  payload: unknown;
};

export type OutputFormat = 'compact' | 'standard' | 'detailed' | 'forensic';
