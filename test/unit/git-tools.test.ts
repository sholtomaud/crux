/**
 * test/unit/git-tools.test.ts
 *
 * Real git repo (not mocked), same rationale as the stepBranch verification:
 * none of the git-shelling helpers in lib/workflow.ts (gitCommitFiles,
 * gitPushBranch, createTaskWorktree) are unit tested with mocks — they're
 * exercised against a real repo instead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { gitCommitFiles, gitPushBranch, createTaskWorktree, resolveTaskCwd, dirtyPaths, commitGuard } from '../../lib/workflow.ts';
import { insertProject, insertTask, updateTaskWorktreePath } from '../../lib/db.ts';

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

  // Regression: `git add <path>` fails with "pathspec did not match any files"
  // once the path is gone from the working tree, so any commit containing a
  // deletion was rejected outright. The documented workaround was to run
  // `git rm --cached` by hand first, which is also why this was easy to miss.
  test('stages and commits a file that has been deleted from the working tree', () => {
    const { work } = makeRepoWithOrigin();
    writeFileSync(join(work, 'doomed.txt'), 'content\n');
    sh('git', ['add', 'doomed.txt'], work);
    sh('git', ['commit', '-m', 'add doomed.txt'], work);

    rmSync(join(work, 'doomed.txt'));
    const result = gitCommitFiles(work, 'remove doomed.txt', ['doomed.txt']);

    assert.equal(result.ok, true, result.out);
    const nameStatus = sh('git', ['show', '--name-status', '--format=', 'HEAD'], work).trim();
    assert.match(nameStatus, /^D\s+doomed\.txt$/m, `expected a recorded deletion, got:\n${nameStatus}`);
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  test('commits an add and a deletion together in one call', () => {
    const { work } = makeRepoWithOrigin();
    writeFileSync(join(work, 'old.txt'), 'old\n');
    sh('git', ['add', 'old.txt'], work);
    sh('git', ['commit', '-m', 'add old.txt'], work);

    rmSync(join(work, 'old.txt'));
    writeFileSync(join(work, 'new.txt'), 'new\n');
    const result = gitCommitFiles(work, 'swap old for new', ['old.txt', 'new.txt']);

    assert.equal(result.ok, true, result.out);
    const nameStatus = sh('git', ['show', '--name-status', '--format=', 'HEAD'], work).trim();
    assert.match(nameStatus, /^D\s+old\.txt$/m);
    assert.match(nameStatus, /^A\s+new\.txt$/m);
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

describe('gitCommitFiles — worktree awareness', () => {
  // Regression test for git-commit-worktree-unaware: crux_task_worktree hands
  // out a sibling worktree, then a commit of files living in it failed with
  // "outside repository at <primary checkout>". The commit root is now derived
  // from the files themselves, so this works with or without a task slug.
  test('commits files that live in a worktree, onto that worktree branch', () => {
    const { work } = makeRepoWithOrigin();
    const wt = createTaskWorktree(work, 'wt-commit').path!;
    const primaryHeadBefore = sh('git', ['rev-parse', 'HEAD'], work).trim();

    writeFileSync(join(wt, 'in-worktree.txt'), 'content\n');
    // cwd is the PRIMARY checkout — the file is only reachable in the worktree
    const result = gitCommitFiles(work, 'add in-worktree.txt', [join(wt, 'in-worktree.txt')]);

    assert.equal(result.ok, true, result.out);
    assert.equal(result.root, wt);
    assert.equal(result.branch, 'feat/wt-commit');
    assert.equal(sh('git', ['log', '-1', '--format=%s'], wt).trim(), 'add in-worktree.txt');
    // the primary checkout must not have moved
    assert.equal(sh('git', ['rev-parse', 'HEAD'], work).trim(), primaryHeadBefore);
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  test('reports the resolved root and branch for ordinary primary-checkout commits', () => {
    const { work } = makeRepoWithOrigin();
    writeFileSync(join(work, 'plain.txt'), 'content\n');
    const result = gitCommitFiles(work, 'add plain.txt', ['plain.txt']);
    assert.equal(result.ok, true, result.out);
    assert.equal(result.root, sh('git', ['rev-parse', '--show-toplevel'], work).trim());
    assert.equal(result.branch, 'main');
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  test('rejects a commit spanning two worktrees without staging anything', () => {
    const { work } = makeRepoWithOrigin();
    const wtA = createTaskWorktree(work, 'span-a').path!;
    const wtB = createTaskWorktree(work, 'span-b').path!;
    const headA = sh('git', ['rev-parse', 'HEAD'], wtA).trim();
    const headB = sh('git', ['rev-parse', 'HEAD'], wtB).trim();

    writeFileSync(join(wtA, 'a.txt'), 'a\n');
    writeFileSync(join(wtB, 'b.txt'), 'b\n');
    const result = gitCommitFiles(work, 'straddle two worktrees', [join(wtA, 'a.txt'), join(wtB, 'b.txt')]);

    assert.equal(result.ok, false);
    assert.match(result.out, /span/i);
    assert.ok(result.out.includes(wtA) && result.out.includes(wtB), 'error names both worktrees');
    // neither side committed, and nothing was left staged
    assert.equal(sh('git', ['rev-parse', 'HEAD'], wtA).trim(), headA);
    assert.equal(sh('git', ['rev-parse', 'HEAD'], wtB).trim(), headB);
    assert.equal(sh('git', ['diff', '--cached', '--name-only'], wtA).trim(), '');
    assert.equal(sh('git', ['diff', '--cached', '--name-only'], wtB).trim(), '');
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

describe('dirtyPaths', () => {
  test('lists modified and untracked paths, and nothing on a clean tree', () => {
    const { work } = makeRepoWithOrigin();
    assert.deepEqual(dirtyPaths(work), []);

    writeFileSync(join(work, 'README.md'), 'modified\n');
    writeFileSync(join(work, 'brand-new.txt'), 'new\n');
    const dirty = dirtyPaths(work).sort();

    assert.deepEqual(dirty, ['README.md', 'brand-new.txt']);
    rmSync(join(work, '..'), { recursive: true, force: true });
  });
});

describe('commitGuard', () => {
  // Regression tests for autonomous-agent-clobbers-worktrees. In GSSK the
  // autonomous engine committed another session's uncommitted edits to
  // src/gssk.c under its own message, and put one task's commits on a sibling
  // task's branch. Both are refusals now.
  const base = { branch: 'feat/x', currentBranch: 'feat/x', preexistingDirty: [], files: ['src/a.ts'] };

  test('allows a commit of files the run itself wrote, on the right branch', () => {
    assert.deepEqual(commitGuard(base), { ok: true });
  });

  test('refuses to commit a file that was already dirty when the run started', () => {
    const r = commitGuard({ ...base, preexistingDirty: ['src/a.ts', 'unrelated.md'] });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /already modified before this run started/);
    assert.ok(r.reason!.includes('src/a.ts'), 'names the offending path');
    assert.ok(!r.reason!.includes('unrelated.md'), 'only names files it was about to commit');
  });

  test('ignores pre-existing dirt in files this commit does not touch', () => {
    assert.deepEqual(commitGuard({ ...base, preexistingDirty: ['some/other/file.c'] }), { ok: true });
  });

  test('refuses to commit onto a sibling task\'s branch', () => {
    const r = commitGuard({ ...base, currentBranch: 'feat/other-task' });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /another task's branch/);
    assert.ok(r.reason!.includes('feat/other-task') && r.reason!.includes('feat/x'));
  });

  test('checks the branch before the dirty-file rule, so the clearer error wins', () => {
    const r = commitGuard({ ...base, currentBranch: 'feat/other', preexistingDirty: ['src/a.ts'] });
    assert.match(r.reason!, /another task's branch/);
  });

  test('allows the commit when the branch cannot be determined', () => {
    assert.deepEqual(commitGuard({ ...base, currentBranch: null }), { ok: true });
  });
});

describe('resolveTaskCwd', () => {
  // Regression test for git-commit-push-worktree-unreachable: crux_git_commit
  // always resolved to the primary repo root, so it could never reach a task's
  // isolated worktree — this function is what lets it target one via slug.
  test('returns the task worktree_path when the task has one and it exists on disk', () => {
    const db = makeDb();
    const proj = insertProject(db, { name: 'p', type: 'code_repo' });
    const task = insertTask(db, { project_id: proj.id, slug: 'my-task', title: 'My task', executor: 'llm' });
    const worktreeDir = mkdtempSync(join(tmpdir(), 'crux-resolve-cwd-'));
    updateTaskWorktreePath(db, task.id, worktreeDir);

    const cwd = resolveTaskCwd(db, proj.id, '/repo/root', 'my-task');

    assert.equal(cwd, worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  test('falls back to repoRoot when the task has no worktree_path', () => {
    const db = makeDb();
    const proj = insertProject(db, { name: 'p', type: 'code_repo' });
    insertTask(db, { project_id: proj.id, slug: 'no-worktree', title: 'No worktree', executor: 'llm' });

    const cwd = resolveTaskCwd(db, proj.id, '/repo/root', 'no-worktree');
    assert.equal(cwd, '/repo/root');
  });

  test('falls back to repoRoot when the recorded worktree_path no longer exists on disk', () => {
    const db = makeDb();
    const proj = insertProject(db, { name: 'p', type: 'code_repo' });
    const task = insertTask(db, { project_id: proj.id, slug: 'stale', title: 'Stale', executor: 'llm' });
    updateTaskWorktreePath(db, task.id, '/does/not/exist/anywhere');

    const cwd = resolveTaskCwd(db, proj.id, '/repo/root', 'stale');
    assert.equal(cwd, '/repo/root');
  });

  test('falls back to repoRoot when no slug is given', () => {
    const db = makeDb();
    const cwd = resolveTaskCwd(db, 'any-project-id', '/repo/root');
    assert.equal(cwd, '/repo/root');
  });

  test('falls back to repoRoot when the slug does not match any task', () => {
    const db = makeDb();
    const proj = insertProject(db, { name: 'p', type: 'code_repo' });
    const cwd = resolveTaskCwd(db, proj.id, '/repo/root', 'no-such-task');
    assert.equal(cwd, '/repo/root');
  });
});

describe('createTaskWorktree', () => {
  test('creates a sibling worktree on feat/<slug>, branched from main', () => {
    const { work } = makeRepoWithOrigin();
    const result = createTaskWorktree(work, 'my-task');
    assert.equal(result.ok, true);
    assert.equal(result.branch, 'feat/my-task');
    assert.ok(existsSync(result.path!));
    const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], result.path!).trim();
    assert.equal(branch, 'feat/my-task');
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  test('recreates a worktree whose directory was deleted by hand, keeping its commits', () => {
    const { work } = makeRepoWithOrigin();
    const first = createTaskWorktree(work, 'deleted-task');
    // a commit made in the worktree before it was removed
    writeFileSync(join(first.path!, 'work-in-progress.txt'), 'wip\n');
    sh('git', ['add', 'work-in-progress.txt'], first.path!);
    sh('git', ['commit', '-m', 'wip commit'], first.path!);
    const wipCommit = sh('git', ['rev-parse', 'HEAD'], first.path!).trim();

    rmSync(first.path!, { recursive: true, force: true });
    const again = createTaskWorktree(work, 'deleted-task');

    assert.equal(again.ok, true, again.out);
    assert.equal(again.reused_branch, true);
    assert.equal(again.branch, 'feat/deleted-task');
    // the branch's prior commit must survive — not be reset to the base
    assert.equal(sh('git', ['rev-parse', 'HEAD'], again.path!).trim(), wipCommit);
    assert.ok(existsSync(join(again.path!, 'work-in-progress.txt')));
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  test('fails if the worktree path already exists', () => {
    const { work } = makeRepoWithOrigin();
    createTaskWorktree(work, 'dup-task');
    const result = createTaskWorktree(work, 'dup-task');
    assert.equal(result.ok, false);
    assert.match(result.out, /already exists/);
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  // Regression tests for worktree-fetch-before-branching.
  test('branches from the fetched remote tip when local main is behind', () => {
    const { bare, work } = makeRepoWithOrigin();
    // A second clone pushes a commit, leaving `work` one behind origin/main.
    const other = join(dirname(work), 'other');
    sh('git', ['clone', bare, other], dirname(work));
    sh('git', ['config', 'user.email', 'test@test.com'], other);
    sh('git', ['config', 'user.name', 'test'], other);
    // The bare repo's HEAD symref may not be 'main', so the clone won't have it
    // checked out — same quirk makeRepoWithOrigin works around when pushing.
    sh('git', ['checkout', '-B', 'main', 'origin/main'], other);
    writeFileSync(join(other, 'remote-only.txt'), 'from elsewhere\n');
    sh('git', ['add', 'remote-only.txt'], other);
    sh('git', ['commit', '-m', 'remote-only commit'], other);
    sh('git', ['push', 'origin', 'main'], other);
    const remoteTip = sh('git', ['rev-parse', 'refs/heads/main'], bare).trim();

    const result = createTaskWorktree(work, 'behind-task');

    assert.equal(result.ok, true, result.out);
    assert.equal(result.behind, 1);
    assert.equal(result.ahead, 0);
    assert.equal(result.base, remoteTip, 'branched from the fetched remote tip, not stale local main');
    assert.equal(sh('git', ['rev-parse', 'HEAD'], result.path!).trim(), remoteTip);
    assert.ok(existsSync(join(result.path!, 'remote-only.txt')), 'remote commit is present in the worktree');
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  test('preserves local commits when local main is ahead of the remote', () => {
    const { work } = makeRepoWithOrigin();
    writeFileSync(join(work, 'local-only.txt'), 'unpushed\n');
    sh('git', ['add', 'local-only.txt'], work);
    sh('git', ['commit', '-m', 'local-only commit'], work);
    const localTip = sh('git', ['rev-parse', 'HEAD'], work).trim();

    const result = createTaskWorktree(work, 'ahead-task');

    assert.equal(result.ok, true, result.out);
    assert.equal(result.ahead, 1);
    assert.equal(result.behind, 0);
    assert.equal(result.base, localTip, 'local commit must not be discarded');
    assert.equal(sh('git', ['rev-parse', 'refs/heads/main'], work).trim(), localTip);
    rmSync(join(work, '..'), { recursive: true, force: true });
  });

  test('succeeds with no remote configured, reporting that it branched locally', () => {
    const base = mkdtempSync(join(tmpdir(), 'crux-no-remote-'));
    const solo = join(base, 'solo');
    sh('git', ['init', solo], base);
    sh('git', ['config', 'user.email', 'test@test.com'], solo);
    sh('git', ['config', 'user.name', 'test'], solo);
    writeFileSync(join(solo, 'README.md'), 'hello\n');
    sh('git', ['add', 'README.md'], solo);
    sh('git', ['commit', '-m', 'initial'], solo);
    sh('git', ['branch', '-M', 'main'], solo);
    const localTip = sh('git', ['rev-parse', 'HEAD'], solo).trim();

    const result = createTaskWorktree(solo, 'no-remote-task');

    assert.equal(result.ok, true, result.out);
    assert.equal(result.remote, null);
    assert.equal(result.base, localTip);
    assert.equal(result.ahead, null);
    assert.equal(result.behind, null);
    assert.equal(sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], result.path!).trim(), 'feat/no-remote-task');
    rmSync(base, { recursive: true, force: true });
  });

  test('when repoRoot HEAD is not main, syncs via fetch without disturbing the current checkout', () => {
    const { work } = makeRepoWithOrigin();
    sh('git', ['checkout', '-b', 'other'], work);
    const result = createTaskWorktree(work, 'from-other-branch');
    assert.equal(result.ok, true);
    // repoRoot's own checkout must be untouched — still on 'other'
    const headBranch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], work).trim();
    assert.equal(headBranch, 'other');
    rmSync(join(work, '..'), { recursive: true, force: true });
  });
});
