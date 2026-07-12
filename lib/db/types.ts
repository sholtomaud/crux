/**
 * lib/db/types.ts — shared type aliases and interfaces
 * All other db modules import from here; nothing else does.
 */

// Single-sourced enum values: each array here is the ONE place a given
// enum's members are listed. Zod schemas in index.ts must reference these
// arrays (z.enum(TASK_TYPES)) rather than retyping the literal list — and
// test/unit/schema-sync.test.ts asserts these match schema.sql's CHECK
// constraints, so drift between schema.sql and the TS/Zod side fails loudly
// instead of silently.
export const PROJECT_TYPES   = ['code_repo', 'article', 'research', 'freelance', 'learning', 'personal'] as const;
export const PROJECT_STATUSES = ['active', 'stalled', 'paused', 'done', 'dropped'] as const;
export const TASK_STATUSES   = ['open', 'in-progress', 'blocked', 'done', 'dropped'] as const;
export const TASK_TYPES      = ['coding', 'writing', 'research', 'accounting', 'verification', 'design', 'other'] as const;
export const TASK_EXECUTORS  = ['llm', 'human', 'hybrid', 'auto'] as const;
export const ESTIMATED_BY_VALUES = ['human', 'claude', 'auto'] as const;
export const AUDIT_ACTORS    = ['human', 'crux-auto', 'claude'] as const;
export const TEST_PHASES     = ['build', 'test-c', 'test-python', 'lint'] as const;
export const ROI_KINDS       = ['revenue', 'cost', 'expected'] as const;
export const RUN_ENVS        = ['shell', 'container'] as const;
export const ADR_STATUSES    = ['proposed', 'accepted', 'deprecated', 'superseded'] as const;

export type ProjectType   = typeof PROJECT_TYPES[number];
export type ProjectStatus = typeof PROJECT_STATUSES[number];
export type TaskStatus    = typeof TASK_STATUSES[number];
export type TaskType      = typeof TASK_TYPES[number];
export type TaskExecutor  = typeof TASK_EXECUTORS[number];
export type EstimatedBy   = typeof ESTIMATED_BY_VALUES[number];
export type AuditActor    = typeof AUDIT_ACTORS[number];
export type TestPhase     = typeof TEST_PHASES[number];
export type RoiKind       = typeof ROI_KINDS[number];
export type RunEnv        = typeof RUN_ENVS[number];
export type AdrStatus     = typeof ADR_STATUSES[number];

export const TEST_RUN_STATUSES = ['pass', 'fail'] as const;
export type TestRunStatus = typeof TEST_RUN_STATUSES[number];

export interface Project {
  id: string;
  project_number: number;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  gh_repo: string | null;
  gh_sync: number;
  sheets_id: string | null;
  hourly_rate: number | null;
  daily_cost: number | null;
  run_env: RunEnv;
  verify_cmd: string | null;
  test_cmd: string | null;
  container_image: string | null;
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
  actual_days: number | null;
  estimated_by: EstimatedBy;
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
  container_name: string | null;
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
  status: TestRunStatus;
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
  status: AdrStatus;
  context: string | null;
  decision: string | null;
  consequences: string | null;
  created_at: string;
}
