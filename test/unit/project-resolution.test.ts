/**
 * test/unit/project-resolution.test.ts
 *
 * Regression test for the cross-session project-resolution bug: a
 * crux_switch call in one session must not redirect another concurrent
 * session's CWD-linked tool calls to the wrong project.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { insertProject, setActiveProjectId } from '../../lib/db.ts';
import { resolveActiveProject } from '../../lib/project-resolution.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SCHEMA     = join(__dirname, '../../schema.sql');

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const sql = readFileSync(SCHEMA, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    db.exec(stmt + ';');
  }
  return db;
}

function makeLinkedRepoDir(projectId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crux-resolution-test-'));
  mkdirSync(join(dir, '.crux'), { recursive: true });
  writeFileSync(join(dir, '.crux', 'project.json'), JSON.stringify({ project_id: projectId }));
  return dir;
}

describe('resolveActiveProject', () => {
  test('CWD link resolves to its own project, ignoring global active_project_id', () => {
    const db = makeDb();
    const projA = insertProject(db, { name: 'crux', type: 'code_repo' });
    const projB = insertProject(db, { name: 'alpha-engine', type: 'code_repo' });
    const dirA  = makeLinkedRepoDir(projA.id);
    const dirB  = makeLinkedRepoDir(projB.id);

    // Simulate session A calling crux_switch to project A (sets the shared global pointer).
    setActiveProjectId(db, projA.id);

    // Session B's own CWD link must still win — this is the regression this bug caused.
    const resolvedForB = resolveActiveProject(db, dirB);
    assert.equal(resolvedForB?.id, projB.id);

    // Session A also resolves correctly via its own CWD link (not coincidentally via the global).
    const resolvedForA = resolveActiveProject(db, dirA);
    assert.equal(resolvedForA?.id, projA.id);
  });

  test('falls back to global active_project_id when there is no CWD link', () => {
    const db = makeDb();
    const proj = insertProject(db, { name: 'no-dir-link', type: 'personal' });
    setActiveProjectId(db, proj.id);

    const resolved = resolveActiveProject(db, null);
    assert.equal(resolved?.id, proj.id);
  });

  test('returns null when there is no CWD link and no global active project', () => {
    const db = makeDb();
    const resolved = resolveActiveProject(db, null);
    assert.equal(resolved, null);
  });
});
