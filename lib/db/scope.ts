/**
 * lib/db/scope.ts — repo-root detection and project pointer I/O
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import type { Project } from './types.ts';
import { projectById } from './projects.ts';

export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.crux'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readProjectPointer(repoRoot: string): string | null {
  const ptr = join(repoRoot, '.crux', 'project.json');
  if (!existsSync(ptr)) return null;
  try {
    const data = JSON.parse(readFileSync(ptr, 'utf8')) as { project_id?: string };
    return data.project_id ?? null;
  } catch { return null; }
}

export function writeProjectPointer(repoRoot: string, projectId: string): void {
  const dir = join(repoRoot, '.crux');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ project_id: projectId }, null, 2));
}

/** Resolve active project from pointer file */
export function resolveProject(db: DatabaseSync, repoRoot: string | null = findRepoRoot()): Project | null {
  if (repoRoot) {
    const id = readProjectPointer(repoRoot);
    if (id) return projectById(db, id);
  }
  return null;
}
