/**
 * lib/cli-format.ts — pure CLI output formatting helpers (no DB/process access)
 *
 * Kept separate from index.ts because index.ts runs its CLI/MCP dispatch as a
 * side effect of module load (no entry-point guard) — importing it from a
 * test file would trigger runCli()/process.exit(). These helpers are safe to
 * import anywhere.
 */

import type { Project } from './db.ts';

export function formatProjectList(projects: Project[], activeId: string | null): string {
  return projects
    .map(p => `  ${p.id === activeId ? '*' : ' '} #${p.project_number}  ${p.name} (${p.id.slice(0, 8)})`)
    .join('\n');
}
