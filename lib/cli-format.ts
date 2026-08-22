/**
 * lib/cli-format.ts — pure CLI output formatting helpers (no DB/process access)
 *
 * Kept separate from index.ts because index.ts runs its CLI/MCP dispatch as a
 * side effect of module load (no entry-point guard) — importing it from a
 * test file would trigger runCli()/process.exit(). These helpers are safe to
 * import anywhere.
 */

import type { AuditEntry, Project, Task } from './db.ts';

export function formatProjectList(projects: Project[], activeId: string | null): string {
  return projects
    .map(p => `  ${p.id === activeId ? '*' : ' '} #${p.project_number}  ${p.name} (${p.id.slice(0, 8)})`)
    .join('\n');
}

/** Neighbours of a task in the dependency DAG, resolved to displayable rows. */
export type TaskRef = Pick<Task, 'slug' | 'title' | 'status'>;

export interface TaskDetailContext {
  predecessors: TaskRef[];
  successors: TaskRef[];
  audit?: AuditEntry[];
}

/** JSON-array columns (files_affected, files_to_create) are text in SQLite and
 *  may hold anything a caller wrote — never let a bad row throw the whole view. */
function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function fileLine(entry: unknown): string {
  if (typeof entry === 'string') return `  - ${entry}`;
  const { path, signature } = entry as { path?: string; signature?: string };
  return `  - ${path ?? JSON.stringify(entry)}${signature ? `  ${signature}` : ''}`;
}

const STATUS_MARK: Record<Task['status'], string> = {
  'done': '✓', 'in-progress': '▸', 'blocked': '✗', 'dropped': '·', 'todo': '·',
};

function refLine(t: TaskRef): string {
  return `  ${STATUS_MARK[t.status] ?? '·'} ${t.slug}  ${t.title}`;
}

/** Full single-task view — the read counterpart to `crux task add`. */
export function formatTaskDetail(task: Task, ctx: TaskDetailContext): string {
  const num = (n: number | null) => (n === null ? '—' : String(n));
  const out: string[] = [];

  out.push(`\n${task.slug} — ${task.title}`);
  out.push(`[${task.status} · ${task.task_type} · ${task.executor}]${task.is_critical ? ' ★ critical path' : ''}`);
  out.push('');
  out.push(`Phase:     ${task.phase ?? '—'}`);
  out.push(`Priority:  ${task.priority}${task.value_score === null ? '' : ` · value ${task.value_score}`}`);
  out.push(`Duration:  ${num(task.duration_days)}d est (by ${task.estimated_by}) · ${num(task.actual_days)}d actual`);
  out.push(`CPM:       ES ${num(task.early_start)} EF ${num(task.early_finish)} · LS ${num(task.late_start)} LF ${num(task.late_finish)} · float ${num(task.float_days)}`);
  if (task.coverage_target !== null) out.push(`Coverage:  ${task.coverage_target}% target`);
  if (task.gh_issue_number !== null) out.push(`Issue:     #${task.gh_issue_number}`);
  if (task.worktree_path) out.push(`Worktree:  ${task.worktree_path}`);
  out.push(`Created:   ${task.created_at}`);

  if (task.description) out.push('', 'Description:', `  ${task.description}`);
  if (task.acceptance_criteria) out.push('', 'Acceptance criteria:', `  ${task.acceptance_criteria}`);

  const affected = parseJsonArray(task.files_affected);
  if (affected.length > 0) out.push('', 'Files affected:', ...affected.map(fileLine));

  const toCreate = parseJsonArray(task.files_to_create);
  if (toCreate.length > 0) out.push('', 'Files to create:', ...toCreate.map(fileLine));

  if (ctx.predecessors.length > 0) out.push('', 'Depends on:', ...ctx.predecessors.map(refLine));
  if (ctx.successors.length > 0) out.push('', 'Blocks:', ...ctx.successors.map(refLine));

  if (ctx.audit && ctx.audit.length > 0) {
    out.push('', 'Recent activity:');
    for (const a of ctx.audit) {
      out.push(`  ${a.created_at}  ${a.event}${a.detail ? `  ${a.detail}` : ''}  (${a.actor})`);
    }
  }

  return out.join('\n');
}
