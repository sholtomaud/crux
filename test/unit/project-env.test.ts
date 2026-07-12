/**
 * test/unit/project-env.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { updateProjectEnvFromFlags } from '../../lib/db/projects.ts';

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

function seedProject(db: DatabaseSync) {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, type) VALUES (?, ?, ?)').run(id, 'test', 'code_repo');
  db.prepare('UPDATE projects SET run_env = ?, verify_cmd = ?, test_cmd = ?, container_image = ? WHERE id = ?')
    .run('container', 'node_modules/.bin/tsc --noEmit', 'npm test 2>&1', null, id);
  return id;
}

function row(db: DatabaseSync, id: string) {
  return db.prepare('SELECT run_env, verify_cmd, test_cmd, container_image FROM projects WHERE id = ?').get(id) as {
    run_env: string; verify_cmd: string | null; test_cmd: string | null; container_image: string | null;
  };
}

describe('updateProjectEnvFromFlags', () => {
  test('omitting all flags leaves existing values unchanged', () => {
    const db = makeDb();
    const id = seedProject(db);
    updateProjectEnvFromFlags(db, id, {});
    const r = row(db, id);
    assert.equal(r.run_env, 'container');
    assert.equal(r.verify_cmd, 'node_modules/.bin/tsc --noEmit');
    assert.equal(r.test_cmd, 'npm test 2>&1');
    db.close();
  });

  test('providing verify_cmd only updates verify_cmd, leaves test_cmd unchanged', () => {
    const db = makeDb();
    const id = seedProject(db);
    updateProjectEnvFromFlags(db, id, { verifyCmd: 'node_modules/.bin/tsgo --noEmit' });
    const r = row(db, id);
    assert.equal(r.verify_cmd, 'node_modules/.bin/tsgo --noEmit');
    assert.equal(r.test_cmd, 'npm test 2>&1');
    db.close();
  });

  test('"none" explicitly clears a field to null', () => {
    const db = makeDb();
    const id = seedProject(db);
    updateProjectEnvFromFlags(db, id, { verifyCmd: 'none' });
    const r = row(db, id);
    assert.equal(r.verify_cmd, null);
    assert.equal(r.test_cmd, 'npm test 2>&1');
    db.close();
  });

  test('run_env updates independently of the cmd fields', () => {
    const db = makeDb();
    const id = seedProject(db);
    updateProjectEnvFromFlags(db, id, { runEnv: 'shell' });
    const r = row(db, id);
    assert.equal(r.run_env, 'shell');
    assert.equal(r.verify_cmd, 'node_modules/.bin/tsc --noEmit');
    db.close();
  });
});
