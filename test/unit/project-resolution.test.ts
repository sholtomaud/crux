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
import { insertProject, setActiveProjectId, readProjectPointer } from '../../lib/db.ts';
import { resolveActiveProject, relinkCwdIfLinked } from '../../lib/project-resolution.ts';

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

describe('relinkCwdIfLinked', () => {
  // Regression test for switch-ignored-by-task-writes: crux_switch reported
  // success but subsequent tool calls still targeted the cwd's originally-linked
  // project, because a CWD link always wins over the global active_project_id
  // fallback and crux_switch never updated it.
  test('re-points an existing CWD link to the new target and reports true', () => {
    const db = makeDb();
    const projOld = insertProject(db, { name: 'old-project', type: 'code_repo' });
    const projNew = insertProject(db, { name: 'new-project', type: 'code_repo' });
    const dir = makeLinkedRepoDir(projOld.id);

    const relinked = relinkCwdIfLinked(dir, projNew.id);

    assert.equal(relinked, true);
    assert.equal(readProjectPointer(dir), projNew.id);
    // The actual bug: after "switching," resolution for this cwd must now
    // reach the new project, not silently keep resolving to the old one.
    assert.equal(resolveActiveProject(db, dir)?.id, projNew.id);
  });

  test('does nothing and returns false when the cwd has no link', () => {
    const db = makeDb();
    const proj = insertProject(db, { name: 'target', type: 'code_repo' });
    const dir = mkdtempSync(join(tmpdir(), 'crux-resolution-test-'));

    const relinked = relinkCwdIfLinked(dir, proj.id);

    assert.equal(relinked, false);
    assert.equal(readProjectPointer(dir), null);
  });

  test('does nothing and returns false when cwdRoot is null', () => {
    const relinked = relinkCwdIfLinked(null, 'any-id');
    assert.equal(relinked, false);
  });
});
