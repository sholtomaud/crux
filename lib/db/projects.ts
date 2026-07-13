/**
 * lib/db/projects.ts — project CRUD
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import type { Project, ProjectType, ProjectStatus, RunEnv } from './types.ts';
import { getConfig, setConfig } from './config.ts';

export function projectById(db: DatabaseSync, id: string): Project | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project) ?? null;
}

export function allProjects(db: DatabaseSync): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY project_number ASC').all() as unknown as Project[];
}

/** Resolves a project by exact id, exact project_number, or case-insensitive substring of name. */
export function resolveProjectByQuery(db: DatabaseSync, query: string): Project | null {
  const all = allProjects(db);
  return (
    all.find(p => p.id === query) ??
    all.find(p => String(p.project_number) === query) ??
    all.find(p => p.name.toLowerCase().includes(query.toLowerCase())) ??
    null
  );
}

export function insertProject(
  db: DatabaseSync,
  opts: { name: string; type: ProjectType; gh_repo?: string; hourly_rate?: number }
): Project {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO projects (id, name, type, gh_repo, hourly_rate)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, opts.name, opts.type, opts.gh_repo ?? null, opts.hourly_rate ?? null);
  db.prepare(`
    UPDATE projects SET project_number = (SELECT COALESCE(MAX(project_number), 0) + 1 FROM projects)
    WHERE id = ? AND project_number IS NULL
  `).run(id);
  return projectById(db, id)!;
}

export function updateProjectStatus(db: DatabaseSync, id: string, status: ProjectStatus): void {
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id);
}

export function updateProjectGhRepo(db: DatabaseSync, id: string, ghRepo: string): void {
  db.prepare('UPDATE projects SET gh_repo = ? WHERE id = ?').run(ghRepo, id);
}

export function updateProjectDailyCost(db: DatabaseSync, id: string, dailyCost: number | null): void {
  db.prepare('UPDATE projects SET daily_cost = ? WHERE id = ?').run(dailyCost, id);
}

export function setDefaultDailyCost(db: DatabaseSync, amount: number): void {
  setConfig(db, 'default_daily_cost', String(amount));
}

/** Per-project daily_cost overrides the global default_daily_cost config key; null if neither is set. */
export function resolveDailyCost(db: DatabaseSync, project: Project): number | null {
  if (project.daily_cost !== null) return project.daily_cost;
  const fallback = getConfig(db, 'default_daily_cost');
  return fallback !== null ? Number(fallback) : null;
}

export function updateProjectEnv(
  db: DatabaseSync,
  id: string,
  opts: { run_env?: RunEnv; verify_cmd?: string | null; test_cmd?: string | null; container_image?: string | null }
): void {
  if (opts.run_env        !== undefined) db.prepare('UPDATE projects SET run_env = ? WHERE id = ?').run(opts.run_env, id);
  if (opts.verify_cmd     !== undefined) db.prepare('UPDATE projects SET verify_cmd = ? WHERE id = ?').run(opts.verify_cmd, id);
  if (opts.test_cmd       !== undefined) db.prepare('UPDATE projects SET test_cmd = ? WHERE id = ?').run(opts.test_cmd, id);
  if (opts.container_image !== undefined) db.prepare('UPDATE projects SET container_image = ? WHERE id = ?').run(opts.container_image, id);
}

/**
 * Resolves CLI flags into an updateProjectEnv() call. A flag left `undefined`
 * (not passed on argv) leaves the existing DB value untouched — passing the
 * literal string 'none' is the explicit way to clear a field to null.
 */
export function updateProjectEnvFromFlags(
  db: DatabaseSync,
  id: string,
  flags: { runEnv?: string; verifyCmd?: string; testCmd?: string; containerImage?: string }
): void {
  const opts: { run_env?: RunEnv; verify_cmd?: string | null; test_cmd?: string | null; container_image?: string | null } = {};
  if (flags.runEnv        !== undefined) opts.run_env         = flags.runEnv as RunEnv;
  if (flags.verifyCmd     !== undefined) opts.verify_cmd      = flags.verifyCmd     === 'none' ? null : flags.verifyCmd;
  if (flags.testCmd       !== undefined) opts.test_cmd        = flags.testCmd       === 'none' ? null : flags.testCmd;
  if (flags.containerImage !== undefined) opts.container_image = flags.containerImage === 'none' ? null : flags.containerImage;
  updateProjectEnv(db, id, opts);
}
