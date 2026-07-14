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
  roiSummary, totalHours, projectStatus,
  taskBySlug, updateTaskStatus, projectById, updateProjectStatus, logAudit,
  activeSession, startSession, endSession,
  TASK_STATUSES, PROJECT_STATUSES,
} from './db.ts';
import type { TaskStatus, ProjectStatus } from './db.ts';
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
    return { ...p, task_count: tasks.length, done_count: tasks.filter(t => t.status === 'done').length, roi, hours };
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
  const allowed = ['projects', 'tasks', 'dependencies', 'sessions', 'roi_records', 'test_runs', 'audit', 'adrs', 'task_adrs'];
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
  updateTaskStatus(db, projectId, slug, status as TaskStatus);
  logAudit(db, { project_id: projectId, task_id: task.id, event: `task.${status}`, actor: 'human' });
  return { status: 200, body: { slug, status } };
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
