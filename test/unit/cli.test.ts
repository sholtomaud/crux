/**
 * test/unit/cli.test.ts — pure CLI formatting/logic helpers from index.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatProjectList } from '../../lib/cli-format.ts';
import type { Project } from '../../lib/db.ts';

function fakeProject(overrides: Partial<Project>): Project {
  return {
    id: 'id', project_number: 1, name: 'name', type: 'code_repo', status: 'active',
    gh_repo: null, gh_sync: 0, sheets_id: null, hourly_rate: null, daily_cost: null,
    run_env: 'shell', verify_cmd: null, test_cmd: null, container_image: null,
    created_at: '2026-01-01',
    ...overrides,
  };
}

describe('formatProjectList', () => {
  test('marks the active project with a star', () => {
    const projects = [
      fakeProject({ id: 'a', project_number: 1, name: 'alpha' }),
      fakeProject({ id: 'b', project_number: 2, name: 'beta' }),
    ];
    const out = formatProjectList(projects, 'b');
    const lines = out.split('\n');
    assert.ok(lines[0].includes('#1') && lines[0].includes('alpha') && !lines[0].includes('*'));
    assert.ok(lines[1].includes('#2') && lines[1].includes('beta') && lines[1].includes('*'));
  });

  test('no star when nothing is active', () => {
    const projects = [fakeProject({ id: 'a', project_number: 1, name: 'alpha' })];
    const out = formatProjectList(projects, null);
    assert.ok(!out.includes('*'));
  });

  test('includes project number and name', () => {
    const projects = [fakeProject({ id: 'a', project_number: 3, name: 'gamma' })];
    const out = formatProjectList(projects, null);
    assert.ok(out.includes('#3'));
    assert.ok(out.includes('gamma'));
  });
});
