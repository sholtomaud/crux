/**
 * test/unit/git-tools.test.ts
 *
 * Real git repo (not mocked), same rationale as the stepBranch verification:
 * none of the other git-shelling helpers in lib/workflow.ts are unit tested
 * with mocks — they're exercised against a real repo instead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitCommitFiles, gitPushBranch } from '../../lib/workflow.ts';

function sh(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function makeRepoWithOrigin(): { bare: string; work: string } {
  const base = mkdtempSync(join(tmpdir(), 'crux-git-tools-'));
  const bare = join(base, 'origin.git');
  const work = join(base, 'work');
  sh('git', ['init', '--bare', bare], base);
  sh('git', ['clone', bare, work], base);
  sh('git', ['config', 'user.email', 'test@test.com'], work);
  sh('git', ['config', 'user.name', 'test'], work);
  writeFileSync(join(work, 'README.md'), 'hello\n');
  sh('git', ['add', 'README.md'], work);
  sh('git', ['commit', '-m', 'initial'], work);
  sh('git', ['branch', '-M', 'main'], work);
  sh('git', ['push', '-u', 'origin', 'main'], work);
  return { bare, work };
}

describe('gitCommitFiles', () => {
  test('creates a real commit with the given message and files', () => {
    const { work } = makeRepoWithOrigin();
    writeFileSync(join(work, 'new-file.txt'), 'content\n');
    const result = gitCommitFiles(work, 'add new-file.txt', ['new-file.txt']);
    assert.equal(result.ok, true);
    const log = sh('git', ['log', '-1', '--format=%s'], work).trim();
    assert.equal(log, 'add new-file.txt');
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  test('returns ok:false and does not commit when no files are given', () => {
    const { work } = makeRepoWithOrigin();
    const before = sh('git', ['rev-parse', 'HEAD'], work).trim();
    const result = gitCommitFiles(work, 'empty commit attempt', []);
    assert.equal(result.ok, false);
    const after = sh('git', ['rev-parse', 'HEAD'], work).trim();
    assert.equal(before, after);
    rmSync(join(work, '..'), { recursive: true, force: true });
  });
});

describe('gitPushBranch', () => {
  test('pushes commits to the real origin', () => {
    const { bare, work } = makeRepoWithOrigin();
    writeFileSync(join(work, 'pushed.txt'), 'content\n');
    gitCommitFiles(work, 'add pushed.txt', ['pushed.txt']);
    const result = gitPushBranch(work, 'main');
    assert.equal(result.ok, true);

    // Verify the commit actually landed on the bare origin, not just locally.
    // (The bare repo's HEAD symref may still point at its original default
    // branch, not 'main' — check the pushed ref explicitly, not HEAD.)
    const remoteLog = sh('git', ['log', '-1', '--format=%s', 'refs/heads/main'], bare).trim();
    assert.equal(remoteLog, 'add pushed.txt');
    rmSync(join(work, '..'), { recursive: true, force: true });
  });
});
