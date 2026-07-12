/**
 * test/unit/workflow-ci-gate.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checksConclusion } from '../../lib/workflow.ts';

describe('checksConclusion', () => {
  test('no check runs at all → none', () => {
    assert.equal(checksConclusion([]), 'none');
  });

  test('any run still in progress → pending', () => {
    assert.equal(checksConclusion([
      { status: 'completed', conclusion: 'success' },
      { status: 'in_progress', conclusion: null },
    ]), 'pending');
  });

  test('all completed, all successful → success', () => {
    assert.equal(checksConclusion([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'neutral' },
      { status: 'completed', conclusion: 'skipped' },
    ]), 'success');
  });

  test('all completed, one failed → failure', () => {
    assert.equal(checksConclusion([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
    ]), 'failure');
  });

  test('all completed, one timed out → failure', () => {
    assert.equal(checksConclusion([
      { status: 'completed', conclusion: 'timed_out' },
    ]), 'failure');
  });

  test('all completed, one cancelled → failure', () => {
    assert.equal(checksConclusion([
      { status: 'completed', conclusion: 'cancelled' },
    ]), 'failure');
  });
});
