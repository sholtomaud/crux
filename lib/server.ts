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
 */

import http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  openDb, allProjects, tasksByProject, dependenciesByProject,
  roiSummary, totalHours, projectStatus,
} from './db.ts';
import { computeCpm } from './cpm.ts';
import type { CpmNode, CpmEdge } from './cpm.ts';
import { UI_ASSETS } from './ui-assets.ts';

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
  json(res, { project, tasks, status, roi, hours });
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

// ── Server ────────────────────────────────────────────────────────────────────

export function startServer(port = 8765, host = '127.0.0.1'): http.Server {
  const db = openDb();

  const server = http.createServer((req, res) => {
    const url  = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;

    // CORS headers (localhost only)
    res.setHeader('Access-Control-Allow-Origin', `http://${host}:${port}`);

    // API routes
    if (path === '/api/overview') return apiOverview(db, res);
    if (path.startsWith('/api/project/')) return apiProject(db, path.slice('/api/project/'.length), res);
    if (path.startsWith('/api/cpm/'))     return apiCpm(db, path.slice('/api/cpm/'.length), res);
    if (path === '/api/roi')              return apiRoi(db, res);
    if (path.startsWith('/api/db/'))      return apiDbTable(db, path.slice('/api/db/'.length), res);

    // Static UI files (served from bundled assets)
    if (path === '/' || path === '/index.html') return serveAsset(res, '/');
    if (path.startsWith('/project'))            return serveAsset(res, '/project.html');
    if (path === '/roi' || path === '/roi.html') return serveAsset(res, '/roi.html');
    if (path.startsWith('/graph'))              return serveAsset(res, '/graph.html');
    if (path === '/db' || path === '/db.html')  return serveAsset(res, '/db.html');
    if (path === '/app.js')                     return serveAsset(res, '/app.js');

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
