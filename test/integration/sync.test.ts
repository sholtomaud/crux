/**
 * test/integration/sync.test.ts
 * Real GitHub calls against sholtomaud/crux-test.
 * All created resources are labelled `pm-test` for easy teardown.
 *
 * Requires: gh CLI authenticated with repo scope.
 * Teardown:
 *   gh issue list --repo sholtomaud/crux-test --label pm-test --json number \
 *     | jq '.[].number' | xargs -I{} gh issue delete {} --repo crux-test --yes
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIssue,
  closeIssue,
  reopenIssue,
  listIssues,
  getIssue,
  ensureLabel,
  syncTasks,
  teardownTestIssues,
  type GhIssue,
} from '../../lib/gh.ts';

const REPO = 'sholtomaud/crux-test';

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(() => {
  ensureLabel(REPO, 'pm-test', 'e4e669', 'Created by crux integration tests');
  ensureLabel(REPO, 'crux',    '0075ca', 'Managed by crux');
});

after(() => {
  teardownTestIssues(REPO);
});

// ── createIssue ───────────────────────────────────────────────────────────────

describe('createIssue', () => {
  test('creates an issue and returns number + url', () => {
    const issue = createIssue(
      REPO,
      '[pm-test] create issue smoke',
      'Created by crux sync.test.ts',
      ['pm-test', 'crux'],
    );
    assert.ok(typeof issue.number === 'number', 'issue.number should be a number');
    assert.ok(issue.number > 0, 'issue.number should be positive');
    assert.ok(typeof issue.url === 'string', 'issue.url should be a string');
    assert.ok(issue.url.includes('crux-test'), 'url should reference the test repo');
  });
});

// ── closeIssue / reopenIssue ─────────────────────────────────────────────────

describe('closeIssue + reopenIssue', () => {
  let issue: GhIssue;

  before(() => {
    issue = createIssue(
      REPO,
      '[pm-test] close+reopen cycle',
      'Created by crux sync.test.ts',
      ['pm-test'],
    );
  });

  test('closes an open issue', () => {
    closeIssue(REPO, issue.number, 'Closed by crux integration test.');
    const closed = getIssue(REPO, issue.number);
    assert.equal(closed.state, 'CLOSED');
  });

  test('reopens a closed issue', () => {
    reopenIssue(REPO, issue.number);
    const reopened = getIssue(REPO, issue.number);
    assert.equal(reopened.state, 'OPEN');
  });
});

// ── listIssues ────────────────────────────────────────────────────────────────

describe('listIssues', () => {
  test('returns issues filtered by label', () => {
    createIssue(REPO, '[pm-test] list filter test', 'body', ['pm-test']);
    const issues = listIssues(REPO, 'pm-test');
    assert.ok(issues.length > 0, 'should return at least one pm-test issue');
    for (const i of issues) {
      assert.ok(
        i.labels.some(l => l === 'pm-test' || (typeof l === 'object' && (l as { name: string }).name === 'pm-test')),
        `issue #${i.number} should have pm-test label`,
      );
    }
  });
});

// ── syncTasks dry-run ─────────────────────────────────────────────────────────

describe('syncTasks', () => {
  test('dry-run: proposes create for tasks without gh_issue_number', () => {
    const tasks = [
      { id: 1, slug: 'setup', title: 'Setup project', status: 'open', gh_issue_number: null },
      { id: 2, slug: 'build', title: 'Build feature', status: 'open', gh_issue_number: null },
    ];
    const actions = syncTasks(REPO, tasks, false);
    assert.equal(actions.length, 2);
    assert.ok(actions.every(a => a.action === 'create'));
  });

  test('dry-run: proposes close for done tasks with linked issue', () => {
    const issue = createIssue(REPO, '[pm-test] sync close test', 'body', ['pm-test']);
    const tasks = [
      { id: 1, slug: 'done-task', title: 'Done task', status: 'done', gh_issue_number: issue.number },
    ];
    const actions = syncTasks(REPO, tasks, false);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'close');
  });

  test('dry-run: skips dropped tasks', () => {
    const tasks = [
      { id: 1, slug: 'dropped-task', title: 'Dropped', status: 'dropped', gh_issue_number: null },
    ];
    const actions = syncTasks(REPO, tasks, false);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'skip');
  });

  test('apply: creates real issue and returns issue number', () => {
    const tasks = [
      { id: 99, slug: 'pm-test-apply', title: '[pm-test] syncTasks apply', status: 'open', gh_issue_number: null },
    ];
    const actions = syncTasks(REPO, tasks, true);
    assert.equal(actions[0].action, 'create');
    assert.ok(typeof actions[0].issue_number === 'number', 'should return created issue number');
    assert.ok(actions[0].issue_number! > 0);
  });
});
