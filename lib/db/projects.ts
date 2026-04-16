/**
 * lib/db/projects.ts — project CRUD
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import type { Project, ProjectType, ProjectStatus } from './types.ts';

export function projectById(db: DatabaseSync, id: string): Project | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project) ?? null;
}

export function allProjects(db: DatabaseSync): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as unknown as Project[];
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
  return projectById(db, id)!;
}

export function updateProjectStatus(db: DatabaseSync, id: string, status: ProjectStatus): void {
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id);
}

export function updateProjectGhRepo(db: DatabaseSync, id: string, ghRepo: string): void {
  db.prepare('UPDATE projects SET gh_repo = ? WHERE id = ?').run(ghRepo, id);
}
