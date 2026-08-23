/**
 * lib/server.ts — Browser UI HTTP server (node:http, no Express)
 * Binds to 127.0.0.1 only. v1 is read-only.
 *
 * Routes:
 *   GET /              → ui/index.html  (meta Kanban)
 *   GET /project/:id   → ui/project.html
 *   GET /roi           → ui/roi.html
 *   GET /graph/:id     → ui/graph.html
 *   GET /db            → ui/db.html
 *   GET /api/overview  → JSON
 *   GET /api/project/:id → JSON
 *   GET /api/cpm/:id   → JSON
 *   GET /api/roi       → JSON
 *   GET /api/db/:table → JSON (raw table data)
 *   POST /api/task/:projectId/:slug/status → JSON (update task status)
 *   POST /api/project/:id/status           → JSON (update project status)
 *   POST /api/project/:id/session/start    → JSON (start a work session)
 *   POST /api/project/:id/session/end      → JSON (end the active work session)
 */

import http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  openDb, allProjects, tasksByProject, dependenciesByProject,
  roiSummary, totalHours, projectStatus, firstRevenueAt,
  taskBySlug, updateTaskStatus, projectById, updateProjectStatus, logAudit,
  activeSession, startSession, endSession, updateTaskFields,
  TASK_STATUSES, PROJECT_STATUSES, TASK_TYPES, TASK_EXECUTORS,
} from './db.ts';
import type {
  TaskStatus, ProjectStatus, TaskType, TaskExecutor,
  TaskFieldPatch, UpdatableTaskField,
} from './db.ts';
import { applyTaskStatus } from './task-transition.ts';
import type { GuardFailure } from './guards.ts';
import { computeCpm } from './cpm.ts';
import type { CpmNode, CpmEdge } from './cpm.ts';
import { UI_ASSETS } from './ui-assets.ts';
import { readCruxConfig } from './config.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function serveAsset(res: http.ServerResponse, key: string): void {
  const asset = UI_ASSETS[key];
  if (!asset) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': asset.mime });
  res.end(asset.content);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

// ── API handlers ──────────────────────────────────────────────────────────────

function apiOverview(db: DatabaseSync, res: http.ServerResponse): void {
  const projects = allProjects(db);
  const data = projects.map(p => {
    const tasks = tasksByProject(db, p.id);
    const roi   = roiSummary(db, p.id);
    const hours = totalHours(db, p.id);
    const status   = projectStatus(db, p.id);
    const nextTask = status.next_unblocked[0] ?? null;
    // A null next_task has two opposite meanings — nothing left to do, or
    // everything left is gated. blocked_by is what tells them apart.
    return {
      ...p,
      task_count: tasks.length,
      done_count: tasks.filter(t => t.status === 'done').length,
      roi, hours,
      next_task: nextTask,
      blocked_by: status.blocked_by,
      first_revenue_at: firstRevenueAt(db, p.id),
    };
  });
  json(res, data);
}

function apiProject(db: DatabaseSync, id: string, res: http.ServerResponse): void {
  const projects = allProjects(db);
  const project  = projects.find(p => p.id === id);
  if (!project) { json(res, { error: 'project not found' }, 404); return; }
  const tasks  = tasksByProject(db, id);
  const status = projectStatus(db, id);
  const roi    = roiSummary(db, id);
  const hours  = totalHours(db, id);
  const deps   = dependenciesByProject(db, id);
  const session = activeSession(db, id);
  json(res, { project, tasks, status, roi, hours, deps, session });
}

function apiCpm(db: DatabaseSync, id: string, res: http.ServerResponse): void {
  const tasks = tasksByProject(db, id);
  const deps  = dependenciesByProject(db, id);
  const nodes: CpmNode[] = tasks.map(t => ({ id: t.id, slug: t.slug, title: t.title, duration: t.duration_days ?? 1, phase: t.phase, value_score: t.value_score }));
  const edges: CpmEdge[] = deps.map(d => ({ predecessor_id: d.predecessor_id, successor_id: d.successor_id }));
  try {
    json(res, computeCpm(nodes, edges));
  } catch (err: unknown) {
    json(res, { error: (err as Error).message }, 500);
  }
}

function apiRoi(db: DatabaseSync, res: http.ServerResponse): void {
  const projects = allProjects(db);
  const data = projects.map(p => {
    const roi   = roiSummary(db, p.id);
    const hours = totalHours(db, p.id);
    const score = hours > 0 ? roi.revenue / hours : null;
    return { id: p.id, name: p.name, type: p.type, status: p.status, hours, roi, roi_per_hour: score };
  });
  json(res, data);
}

function apiDbTable(db: DatabaseSync, table: string, res: http.ServerResponse): void {
  const allowed = ['projects', 'tasks', 'dependencies', 'sessions', 'roi_records', 'test_runs', 'audit', 'adrs', 'task_adrs', 'agent_runs'];
  if (!allowed.includes(table)) { json(res, { error: 'table not allowed' }, 403); return; }
  const rows = db.prepare(`SELECT * FROM ${table} LIMIT 500`).all();
  json(res, rows);
}

// ── Write handlers (pure functions of db + args — unit-testable without HTTP) ─

type ApiResult = { status: number; body: unknown };

export function updateTaskStatusHandler(db: DatabaseSync, projectId: string, slug: string, status: unknown): ApiResult {
  if (typeof status !== 'string' || !TASK_STATUSES.includes(status as TaskStatus)) {
    return { status: 400, body: { error: `invalid status: ${String(status)}` } };
  }
  const task = taskBySlug(db, projectId, slug);
  if (!task) return { status: 404, body: { error: 'task not found' } };
  const transition = applyTaskStatus(db, projectId, slug, status as TaskStatus, { actor: 'human' });
  if (!transition.applied) return { status: 409, body: { error: transition.blocked } };
  logAudit(db, { project_id: projectId, task_id: task.id, event: `task.${status}`, actor: 'human' });
  return { status: 200, body: { slug, status, ...(transition.warnings.length ? { guard_warnings: transition.warnings } : {}) } };
}

/**
 * Full task edit for the detail panel (PATCH /api/task/:projectId/:slug).
 *
 * Three rules make this safe to point a form at:
 *   1. Only UPDATABLE_TASK_FIELDS and `status` are read from the body; anything
 *      else is dropped silently, so a client that PATCHes back a whole task row
 *      it just fetched does the obvious right thing instead of erroring.
 *   2. Everything is validated before anything is written.
 *   3. Status still goes through applyTaskStatus, so ADR-012 guards fire here
 *      exactly as they do for the CLI and MCP.
 */
export function updateTaskHandler(db: DatabaseSync, projectId: string, slug: string, body: unknown): ApiResult {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { error: 'body must be a JSON object' } };
  }
  const patch = body as Record<string, unknown>;
  const task  = taskBySlug(db, projectId, slug);
  if (!task) return { status: 404, body: { error: 'task not found' } };

  const bad = (field: string, why: string): ApiResult =>
    ({ status: 400, body: { error: `${field}: ${why}`, field } });

  const fields: TaskFieldPatch = {};

  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim() === '') return bad('title', 'must be a non-empty string');
    fields.title = patch.title.trim();
  }
  // Nullable free text: an empty string clears the column rather than storing
  // '', so "I deleted the description" and "there was never one" stay one state.
  for (const f of ['description', 'phase', 'acceptance_criteria'] as const) {
    if (patch[f] === undefined) continue;
    if (patch[f] !== null && typeof patch[f] !== 'string') return bad(f, 'must be a string or null');
    const v = patch[f] === null ? null : String(patch[f]).trim();
    fields[f] = v === '' ? null : v;
  }
  const num = (
    f: 'priority' | 'duration_days' | 'value_score',
    opts: { min: number; max: number; integer?: boolean; exclusiveMin?: boolean; nullable?: boolean },
  ): ApiResult | null => {
    if (patch[f] === undefined) return null;
    const v = patch[f];
    // Clearing a number field sends null. Only columns the schema allows to be
    // NULL may take it; priority is NOT NULL, so emptying it is an error.
    if (v === null) {
      if (!opts.nullable) return bad(f, 'cannot be cleared');
      fields[f] = null;
      return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return bad(f, 'must be a finite number');
    if (opts.integer && !Number.isInteger(v)) return bad(f, 'must be a whole number');
    if (opts.exclusiveMin ? v <= opts.min : v < opts.min) return bad(f, `must be greater than ${opts.exclusiveMin ? opts.min : `or equal to ${opts.min}`}`);
    if (v > opts.max) return bad(f, `must be at most ${opts.max}`);
    fields[f] = v;
    return null;
  };
  // duration_days excludes 0: taskWsjf and the CPM float pass both divide by it.
  for (const e of [
    num('priority',      { min: 0, max: 100, integer: true }),
    num('value_score',   { min: 0, max: 100, nullable: true }),
    num('duration_days', { min: 0, max: 3650, exclusiveMin: true, nullable: true }),
  ]) {
    if (e) return e;
  }
  if (patch.task_type !== undefined) {
    if (typeof patch.task_type !== 'string' || !TASK_TYPES.includes(patch.task_type as TaskType)) return bad('task_type', `must be one of ${TASK_TYPES.join(', ')}`);
    fields.task_type = patch.task_type;
  }
  if (patch.executor !== undefined) {
    if (typeof patch.executor !== 'string' || !TASK_EXECUTORS.includes(patch.executor as TaskExecutor)) return bad('executor', `must be one of ${TASK_EXECUTORS.join(', ')}`);
    fields.executor = patch.executor;
  }
  let nextStatus: TaskStatus | null = null;
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !TASK_STATUSES.includes(patch.status as TaskStatus)) return bad('status', `must be one of ${TASK_STATUSES.join(', ')}`);
    if (patch.status !== task.status) nextStatus = patch.status as TaskStatus;
  }

  // Drop no-op writes so the audit detail names what genuinely moved.
  for (const key of Object.keys(fields) as UpdatableTaskField[]) {
    if (fields[key] === (task[key] ?? null)) delete fields[key];
  }

  // Status first, so a blocked transition aborts before any other write.
  let warnings: GuardFailure[] = [];
  if (nextStatus) {
    const transition = applyTaskStatus(db, projectId, slug, nextStatus, { actor: 'human' });
    if (!transition.applied) return { status: 409, body: { error: transition.blocked, field: 'status' } };
    warnings = transition.warnings;
  }
  const changed = updateTaskFields(db, task.id, fields);

  const changedNames = [...(nextStatus ? ['status'] : []), ...changed];
  if (changedNames.length > 0) {
    logAudit(db, { project_id: projectId, task_id: task.id, event: 'task.update', detail: changedNames.join(', '), actor: 'human' });
  }

  return {
    status: 200,
    body: {
      task: taskBySlug(db, projectId, slug),
      changed: changedNames,
      ...(warnings.length ? { guard_warnings: warnings } : {}),
    },
  };
}

export function sessionStartHandler(db: DatabaseSync, projectId: string): ApiResult {
  const project = projectById(db, projectId);
  if (!project) return { status: 404, body: { error: 'project not found' } };
  if (activeSession(db, projectId)) return { status: 409, body: { error: 'session already active' } };
  const session = startSession(db, projectId);
  logAudit(db, { project_id: projectId, event: 'session.start', actor: 'human' });
  return { status: 200, body: { session } };
}

export function sessionEndHandler(db: DatabaseSync, projectId: string, note: unknown): ApiResult {
  const project = projectById(db, projectId);
  if (!project) return { status: 404, body: { error: 'project not found' } };
  const active = activeSession(db, projectId);
  if (!active) return { status: 409, body: { error: 'no active session' } };
  const session = endSession(db, active.id, typeof note === 'string' ? note : undefined);
  logAudit(db, { project_id: projectId, event: 'session.end', detail: session.minutes != null ? `${session.minutes}m` : undefined, actor: 'human' });
  return { status: 200, body: { session } };
}

export function updateProjectStatusHandler(db: DatabaseSync, id: string, status: unknown): ApiResult {
  if (typeof status !== 'string' || !PROJECT_STATUSES.includes(status as ProjectStatus)) {
    return { status: 400, body: { error: `invalid status: ${String(status)}` } };
  }
  const project = projectById(db, id);
  if (!project) return { status: 404, body: { error: 'project not found' } };
  updateProjectStatus(db, id, status as ProjectStatus);
  logAudit(db, { project_id: id, event: `project.${status}`, actor: 'human' });
  return { status: 200, body: { id, status } };
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(undefined); }
    });
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

export function startServer(port = readCruxConfig().ui_port, host = '127.0.0.1'): http.Server {
  const db = openDb();

  const server = http.createServer(async (req, res) => {
    const url  = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;

    // CORS headers (localhost only)
    res.setHeader('Access-Control-Allow-Origin', `http://${host}:${port}`);

    // Full task edit (PATCH) — the detail panel's save path
    if (req.method === 'PATCH') {
      const m = path.match(/^\/api\/task\/([^/]+)\/([^/]+)$/);
      if (m) {
        const body   = await readJsonBody(req);
        const result = updateTaskHandler(db, decodeURIComponent(m[1]), decodeURIComponent(m[2]), body);
        return json(res, result.body, result.status);
      }
    }

    // Write routes (POST)
    if (req.method === 'POST') {
      const taskMatch = path.match(/^\/api\/task\/([^/]+)\/([^/]+)\/status$/);
      if (taskMatch) {
        const body   = await readJsonBody(req) as { status?: unknown } | undefined;
        const result = updateTaskStatusHandler(db, decodeURIComponent(taskMatch[1]), decodeURIComponent(taskMatch[2]), body?.status);
        return json(res, result.body, result.status);
      }
      const projectMatch = path.match(/^\/api\/project\/([^/]+)\/status$/);
      if (projectMatch) {
        const body   = await readJsonBody(req) as { status?: unknown } | undefined;
        const result = updateProjectStatusHandler(db, decodeURIComponent(projectMatch[1]), body?.status);
        return json(res, result.body, result.status);
      }
      const sessionStartMatch = path.match(/^\/api\/project\/([^/]+)\/session\/start$/);
      if (sessionStartMatch) {
        const result = sessionStartHandler(db, decodeURIComponent(sessionStartMatch[1]));
        return json(res, result.body, result.status);
      }
      const sessionEndMatch = path.match(/^\/api\/project\/([^/]+)\/session\/end$/);
      if (sessionEndMatch) {
        const body   = await readJsonBody(req) as { note?: unknown } | undefined;
        const result = sessionEndHandler(db, decodeURIComponent(sessionEndMatch[1]), body?.note);
        return json(res, result.body, result.status);
      }
    }

    // API routes
    if (path === '/api/overview') return apiOverview(db, res);
    if (path.startsWith('/api/project/')) return apiProject(db, path.slice('/api/project/'.length), res);
    if (path.startsWith('/api/cpm/'))     return apiCpm(db, path.slice('/api/cpm/'.length), res);
    if (path === '/api/roi')              return apiRoi(db, res);
    if (path.startsWith('/api/db/'))      return apiDbTable(db, path.slice('/api/db/'.length), res);

    // PWA: allow service worker to intercept all paths under /
    res.setHeader('Service-Worker-Allowed', '/');

    // Static UI files (served from bundled assets)
    if (path === '/' || path === '/index.html') return serveAsset(res, '/');
    if (path.startsWith('/project'))            return serveAsset(res, '/project.html');
    if (path === '/roi' || path === '/roi.html') return serveAsset(res, '/roi.html');
    if (path.startsWith('/graph'))              return serveAsset(res, '/graph.html');
    if (path === '/db' || path === '/db.html')  return serveAsset(res, '/db.html');
    if (path === '/tokens.css')                 return serveAsset(res, '/tokens.css');
    if (path === '/theme.js')                   return serveAsset(res, '/theme.js');
    if (path === '/app.js')                     return serveAsset(res, '/app.js');
    if (path === '/sw.js')                      return serveAsset(res, '/sw.js');
    if (path === '/manifest.json')              return serveAsset(res, '/manifest.json');
    if (path === '/icon.svg')                   return serveAsset(res, '/icon.svg');

    notFound(res);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Port already in use — another crux instance has the UI, silently ignore
    } else {
      console.error(`crux ui error: ${err.message}`);
    }
  });

  server.listen(port, host, () => {
    process.stderr.write(`crux ui → http://${host}:${port}\n`);
  });

  return server;
}
