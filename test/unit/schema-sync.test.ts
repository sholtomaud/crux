/**
 * test/unit/schema-sync.test.ts
 *
 * Guards against schema.sql's CHECK(col IN (...)) constraints drifting away
 * from the single-sourced TS/Zod enum constants in lib/db/types.ts. Column
 * names repeat across tables (several tables have a `status` column with
 * different value sets), so each CHECK is extracted scoped to its own
 * CREATE TABLE block, not by column name alone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_TYPES, PROJECT_STATUSES, TASK_STATUSES, TASK_TYPES, TASK_EXECUTORS,
  ESTIMATED_BY_VALUES, RUN_ENVS, ROI_KINDS, TEST_PHASES, TEST_RUN_STATUSES, ADR_STATUSES,
  AUDIT_ACTORS,
} from '../../lib/db/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SCHEMA     = readFileSync(join(__dirname, '../../schema.sql'), 'utf8');

function tableBlock(sql: string, tableName: string): string {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`);
  const m = sql.match(re);
  if (!m) throw new Error(`table ${tableName} not found in schema.sql`);
  return m[1];
}

function checkValues(block: string, column: string): string[] {
  const re = new RegExp(`\\b${column}\\b[^\\n]*CHECK\\(${column} IN \\(([^)]*)\\)\\)`);
  const m = block.match(re);
  if (!m) throw new Error(`CHECK(${column} IN (...)) not found in table block`);
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(s => s.toUpperCase() !== 'NULL')
    .map(s => s.replace(/^'(.*)'$/, '$1'));
}

function sameMembers(actual: string[], expected: readonly string[]): void {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

describe('schema.sql CHECK constraints match single-sourced TS enum constants', () => {
  test('projects.type === PROJECT_TYPES', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'projects'), 'type'), PROJECT_TYPES);
  });

  test('projects.status === PROJECT_STATUSES', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'projects'), 'status'), PROJECT_STATUSES);
  });

  test('projects.run_env === RUN_ENVS', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'projects'), 'run_env'), RUN_ENVS);
  });

  test('tasks.status === TASK_STATUSES', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'tasks'), 'status'), TASK_STATUSES);
  });

  test('tasks.task_type === TASK_TYPES', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'tasks'), 'task_type'), TASK_TYPES);
  });

  test('tasks.executor === TASK_EXECUTORS', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'tasks'), 'executor'), TASK_EXECUTORS);
  });

  test('tasks.estimated_by === ESTIMATED_BY_VALUES', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'tasks'), 'estimated_by'), ESTIMATED_BY_VALUES);
  });

  test('roi_records.kind === ROI_KINDS', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'roi_records'), 'kind'), ROI_KINDS);
  });

  test('test_runs.phase === TEST_PHASES (NULL-allowance stripped)', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'test_runs'), 'phase'), TEST_PHASES);
  });

  test('test_runs.status === TEST_RUN_STATUSES', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'test_runs'), 'status'), TEST_RUN_STATUSES);
  });

  test('adrs.status === ADR_STATUSES', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'adrs'), 'status'), ADR_STATUSES);
  });

  test('audit.actor === AUDIT_ACTORS', () => {
    sameMembers(checkValues(tableBlock(SCHEMA, 'audit'), 'actor'), AUDIT_ACTORS);
  });
});
