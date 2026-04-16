/**
 * lib/db/types.ts — shared type aliases and interfaces
 * All other db modules import from here; nothing else does.
 */

export type ProjectType   = 'code_repo' | 'article' | 'research' | 'freelance' | 'learning' | 'personal';
export type ProjectStatus = 'active' | 'stalled' | 'paused' | 'done' | 'dropped';
export type TaskStatus    = 'open' | 'in-progress' | 'blocked' | 'done' | 'dropped';
export type TaskType      = 'coding' | 'writing' | 'research' | 'accounting' | 'verification' | 'design' | 'other';
export type TaskExecutor  = 'llm' | 'human' | 'hybrid' | 'auto';
export type AuditActor    = 'human' | 'crux-auto' | 'claude';
export type TestPhase     = 'build' | 'test-c' | 'test-python' | 'lint';
export type RoiKind       = 'revenue' | 'cost' | 'expected';

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  gh_repo: string | null;
  gh_sync: number;
  sheets_id: string | null;
  hourly_rate: number | null;
  created_at: string;
}

export interface Task {
  id: number;
  project_id: string;
  slug: string;
  title: string;
  description: string | null;
  phase: string | null;
  status: TaskStatus;
  priority: number;
  duration_days: number | null;
  early_start: number | null;
  early_finish: number | null;
  late_start: number | null;
  late_finish: number | null;
  float_days: number | null;
  is_critical: number;
  gh_issue_number: number | null;
  coverage_target: number | null;
  value_score: number | null;
  task_type: TaskType;
  executor: TaskExecutor;
  acceptance_criteria: string | null;
  files_affected: string | null;   // JSON array of file paths to modify
  files_to_create: string | null;  // JSON array of {path,signature} — new files only
  created_at: string;
}

export interface Session {
  id: number;
  project_id: string;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  minutes: number | null;
}

export interface RoiRecord {
  id: number;
  project_id: string;
  recorded_at: string;
  amount: number;
  currency: string;
  kind: RoiKind;
  probability: number;
  note: string | null;
}

export interface TestRun {
  id: number;
  project_id: string;
  task_slug: string | null;
  run_at: string;
  phase: TestPhase | null;
  status: 'pass' | 'fail';
  coverage: number | null;
  output: string | null;
  commit_sha: string | null;
}

export interface AuditEntry {
  id: number;
  project_id: string | null;
  task_id: number | null;
  event: string;
  detail: string | null;
  actor: AuditActor;
  created_at: string;
}

export interface Adr {
  id: number;
  project_id: string;
  number: number;
  title: string;
  status: 'proposed' | 'accepted' | 'deprecated' | 'superseded';
  context: string | null;
  decision: string | null;
  consequences: string | null;
  created_at: string;
}
