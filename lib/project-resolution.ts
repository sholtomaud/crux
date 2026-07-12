/**
 * lib/project-resolution.ts — shared project-resolution logic for MCP mode
 *
 * CWD-based .crux/project.json takes precedence. Global active_project_id
 * (set via crux_switch) is only a fallback for sessions with no directory
 * link — it must never override a session's own CWD link, since that value
 * is a single row in global_config shared across every concurrent crux
 * connection reading the same ~/.crux/crux.db.
 */

import type { DatabaseSync } from 'node:sqlite';
import { resolveProject } from './db.ts';
import { getActiveProjectId } from './db.ts';
import { projectById } from './db.ts';
import type { Project } from './db.ts';

export function resolveActiveProject(db: DatabaseSync, cwdRoot: string | null): Project | null {
  const cwdProj = resolveProject(db, cwdRoot);
  if (cwdProj) return cwdProj;

  const activeId = getActiveProjectId(db);
  if (activeId) {
    const proj = projectById(db, activeId);
    if (proj) return proj;
  }
  return null;
}
