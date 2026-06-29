import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  createWriteStream,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Annotation } from './types.js';

export const WEBPACK_ENDPOINT = '/_tian-annotate/api';
const DATA_DIR = '.tian-annotate';

// ---------------------------------------------------------------------------
// Storage (identical to vite-plugin.ts — both write to .tian-annotate/)
// ---------------------------------------------------------------------------

function ensureDir(root: string) {
  const dir = resolve(root, DATA_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function annotationsPath(root: string) {
  return join(ensureDir(root), 'annotations.json');
}

function readAnnotations(root: string): Annotation[] {
  const p = annotationsPath(root);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

function writeAnnotations(root: string, annotations: Annotation[]) {
  writeFileSync(annotationsPath(root), JSON.stringify(annotations, null, 2));
}

function readAgentConfig(root: string): { agent?: 'claude' | 'opencode' } {
  const cfgPath = join(root, DATA_DIR, 'config.json');
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const DEFAULT_COMMANDS: Record<'claude' | 'opencode', string[]> = {
  claude: ['claude', '-p', '--dangerously-skip-permissions'],
  opencode: ['opencode', 'run', '--dangerously-skip-permissions'],
};

function buildPrompt(id: string, comment: string, elementPath: string): string {
  return (
    `An annotation was left on a web app for you to fix. ` +
    `Annotation ID: ${id}. Element: ${elementPath}. Feedback: ${comment}. ` +
    `Use the tian-annotate MCP tools to get full context before making any change: ` +
    `call tian_annotate_get_annotation with id "${id}" to read the complete ` +
    `details (CSS classes, computed styles, component tree, accessibility info). ` +
    `Locate and fix the underlying source file in this project. When done, call ` +
    `tian_annotate_reply with a short summary of what you changed, then call ` +
    `tian_annotate_resolve with the same id. If you cannot safely fix it, call ` +
    `tian_annotate_dismiss with a reason instead of guessing.`
  );
}

function resolveExe(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  try {
    const out = execFileSync('where', [cmd], { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
    if (exe) return exe;
    const shim = lines.find((l) => l.toLowerCase().endsWith('.cmd'));
    if (!shim) return cmd;
    const content = readFileSync(shim, 'utf8');
    const m = content.match(/%dp0%\\([^"%]+\.exe)/i);
    if (!m) return cmd;
    const real = resolve(resolve(shim, '..'), m[1]);
    return existsSync(real) ? real : cmd;
  } catch {
    return cmd;
  }
}

type ThreadCallback = (msg: { role: 'human' | 'agent'; content: string }) => void;

function spawnAgent(
  root: string,
  annotation: Annotation,
  agent: 'claude' | 'opencode',
  model: string | undefined,
  onThread: ThreadCallback
) {
  const prompt = buildPrompt(annotation.id, annotation.comment, annotation.elementPath);
  const [rawCmd, ...baseArgs] = DEFAULT_COMMANDS[agent];
  const resolvedCmd = resolveExe(rawCmd);
  const useShell = process.platform === 'win32' && !resolvedCmd.toLowerCase().endsWith('.exe');
  const modelArgs = model ? ['--model', model] : [];
  const promptArg = useShell ? `"${prompt.replace(/"/g, '""')}"` : prompt;

  onThread({ role: 'agent', content: `Dispatching ${agent} (started in ${root})…` });

  const logsDir = join(ensureDir(root), 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `${annotation.id}-${agent}-${Date.now()}.log`);
  const logStream = createWriteStream(logPath);

  const child = spawn(resolvedCmd, [...baseArgs, ...modelArgs, promptArg], {
    cwd: root,
    shell: useShell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout?.on('data', (d: Buffer) => { out += d; logStream.write(d); });
  child.stderr?.on('data', (d: Buffer) => { out += d; logStream.write(d); });
  child.on('error', (err: Error) => {
    logStream.end();
    onThread({ role: 'agent', content: `Failed to start ${agent}: ${err.message}` });
  });
  child.on('close', (code: number | null) => {
    logStream.end();
    const tail = out.slice(-800);
    onThread({
      role: 'agent',
      content:
        code === 0
          ? `${agent} finished. Log: ${logPath}\n\n${tail}`
          : `${agent} exited with code ${code}. Log: ${logPath}\n\n${tail}`,
    });
  });
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface TianAnnotateMiddlewareOptions {
  /** API prefix. Default: /_tian-annotate/api */
  endpoint?: string;
  /** Project root. Default: process.cwd() */
  root?: string;
}

type NextFn = (err?: unknown) => void;

/**
 * Returns a Node.js middleware that handles all tian-annotate API routes.
 *
 * webpack-dev-server v4+ (webpack 5):
 *   setupMiddlewares: (middlewares, devServer) => {
 *     devServer.app.use(tianAnnotateMiddleware())
 *     return middlewares
 *   }
 *
 * webpack-dev-server v3:
 *   before: (app) => { app.use(tianAnnotateMiddleware()) }
 */
export function tianAnnotateMiddleware(options: TianAnnotateMiddlewareOptions = {}) {
  const prefix = options.endpoint ?? WEBPACK_ENDPOINT;
  const root = options.root ?? process.cwd();

  return async (req: IncomingMessage, res: ServerResponse, next: NextFn) => {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith(prefix)) return next();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const path = rawUrl.slice(prefix.length).split('?')[0];
    const method = req.method ?? 'GET';

    // GET /health
    if (method === 'GET' && path === '/health') {
      const cfg = readAgentConfig(root);
      return sendJson(res, 200, {
        ok: true,
        mode: 'webpack-middleware',
        defaultAgent: cfg.agent ?? null,
      });
    }

    const annotations = readAnnotations(root);

    // GET /annotations
    if (method === 'GET' && path === '/annotations') {
      const qs = new URLSearchParams(rawUrl.split('?')[1] ?? '');
      let result = annotations;
      const sid = qs.get('sessionId');
      const st = qs.get('status');
      if (sid) result = result.filter((a) => !a.sessionId || a.sessionId === sid);
      if (st) result = result.filter((a) => a.status === st);
      return sendJson(res, 200, result);
    }

    // POST /annotations
    if (method === 'POST' && path === '/annotations') {
      const body = await readBody(req);
      const now = new Date().toISOString();
      const annotation: Annotation = {
        ...(body as Partial<Annotation>),
        id: body.id as string,
        comment: (body.comment as string) ?? '',
        elementPath: (body.elementPath as string) ?? '',
        timestamp: (body.timestamp as number) ?? Date.now(),
        x: (body.x as number) ?? 0,
        y: (body.y as number) ?? 0,
        element: (body.element as string) ?? '',
        status: (body.status as Annotation['status']) ?? 'pending',
        createdAt: now,
        updatedAt: now,
      };
      annotations.push(annotation);
      writeAnnotations(root, annotations);
      return sendJson(res, 201, annotation);
    }

    // /annotations/:id
    const idM = path.match(/^\/annotations\/([^/]+)$/);
    if (idM) {
      const id = idM[1];
      const idx = annotations.findIndex((a) => a.id === id);

      if (method === 'GET') {
        if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
        return sendJson(res, 200, annotations[idx]);
      }

      if (method === 'PATCH') {
        if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
        const body = await readBody(req);
        annotations[idx] = {
          ...annotations[idx],
          ...(body as Partial<Annotation>),
          updatedAt: new Date().toISOString(),
        };
        writeAnnotations(root, annotations);
        return sendJson(res, 200, annotations[idx]);
      }

      if (method === 'DELETE') {
        if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
        annotations.splice(idx, 1);
        writeAnnotations(root, annotations);
        return sendJson(res, 200, { ok: true });
      }
    }

    // POST /annotations/:id/dispatch
    const dispM = path.match(/^\/annotations\/([^/]+)\/dispatch$/);
    if (dispM && method === 'POST') {
      const id = dispM[1];
      const body = await readBody(req);
      const agent = body?.agent as string;
      if (agent !== 'claude' && agent !== 'opencode') {
        return sendJson(res, 400, { error: 'agent must be "claude" or "opencode"' });
      }
      const idx = annotations.findIndex((a) => a.id === id);
      if (idx === -1) return sendJson(res, 404, { error: 'Annotation not found' });
      const model =
        typeof body?.model === 'string' && (body.model as string).trim()
          ? (body.model as string).trim()
          : undefined;

      spawnAgent(root, annotations[idx], agent as 'claude' | 'opencode', model, (msg) => {
        const current = readAnnotations(root);
        const i = current.findIndex((a) => a.id === id);
        if (i === -1) return;
        if (!current[i].thread) current[i].thread = [];
        current[i].thread!.push({
          id: `msg-${Date.now()}`,
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
        });
        current[i].updatedAt = new Date().toISOString();
        writeAnnotations(root, current);
      });

      return sendJson(res, 202, { started: true });
    }

    // POST /annotations/:id/thread
    const threadM = path.match(/^\/annotations\/([^/]+)\/thread$/);
    if (threadM && method === 'POST') {
      const id = threadM[1];
      const idx = annotations.findIndex((a) => a.id === id);
      if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
      const body = await readBody(req);
      if (!body.role || !body.content) {
        return sendJson(res, 400, { error: 'role and content required' });
      }
      if (!annotations[idx].thread) annotations[idx].thread = [];
      const message = {
        id: `msg-${Date.now()}`,
        role: body.role as 'human' | 'agent',
        content: body.content as string,
        timestamp: Date.now(),
      };
      annotations[idx].thread!.push(message);
      annotations[idx].updatedAt = new Date().toISOString();
      writeAnnotations(root, annotations);
      return sendJson(res, 200, message);
    }

    next();
  };
}
