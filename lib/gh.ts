/**
 * lib/gh.ts — GitHub CLI wrappers
 * Shells out to the `gh` CLI. No Octokit, no GitHub API client.
 * All sync is opt-in per project.
 */

import { execSync, spawnSync } from 'node:child_process';

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  url: string;
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

function gh(args: string[], opts: { repo?: string; json?: boolean } = {}): unknown {
  const repoFlag = opts.repo ? ['--repo', opts.repo] : [];
  const jsonFlag = opts.json ? ['--json', 'number,title,state,labels,url'] : [];
  const cmd = ['gh', ...args, ...repoFlag, ...jsonFlag];

  const result = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.error) throw new Error(`gh not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh failed: ${result.stderr.trim()}`);

  if (opts.json) return JSON.parse(result.stdout.trim());
  return result.stdout.trim();
}

// ── Issue operations ──────────────────────────────────────────────────────────

export function createIssue(repo: string, title: string, body: string, labels: string[] = []): GhIssue {
  const labelFlag = labels.flatMap(l => ['--label', l]);
  // gh issue create returns the issue URL in stdout (--json not supported on create)
  const url = gh(
    ['issue', 'create', '--title', title, '--body', body, ...labelFlag],
    { repo },
  ) as string;
  // Extract issue number from URL: https://github.com/owner/repo/issues/123
  const match = url.match(/\/issues\/(\d+)/);
  if (!match) throw new Error(`Could not parse issue number from gh output: ${url}`);
  const number = parseInt(match[1], 10);
  return getIssue(repo, number);
}

export function closeIssue(repo: string, number: number, comment?: string): void {
  if (comment) {
    gh(['issue', 'comment', String(number), '--body', comment], { repo });
  }
  gh(['issue', 'close', String(number)], { repo });
}

export function reopenIssue(repo: string, number: number): void {
  gh(['issue', 'reopen', String(number)], { repo });
}

export function editIssue(repo: string, number: number, opts: { title?: string; body?: string; labels?: string[] }): void {
  const args: string[] = ['issue', 'edit', String(number)];
  if (opts.title) args.push('--title', opts.title);
  if (opts.body)  args.push('--body', opts.body);
  if (opts.labels) opts.labels.forEach(l => args.push('--add-label', l));
  gh(args, { repo });
}

export function listIssues(repo: string, label?: string): GhIssue[] {
  const labelFlag = label ? ['--label', label] : [];
  return gh(['issue', 'list', '--state', 'all', '--limit', '200', ...labelFlag], { repo, json: true }) as GhIssue[];
}

export function getIssue(repo: string, number: number): GhIssue {
  return gh(['issue', 'view', String(number)], { repo, json: true }) as GhIssue;
}

// ── Milestone operations ──────────────────────────────────────────────────────

export function createMilestoneIssue(repo: string, phase: string, body: string): GhIssue {
  return createIssue(repo, `Milestone: ${phase} complete`, body, ['milestone']);
}

// ── Label management ─────────────────────────────────────────────────────────

export function ensureLabel(repo: string, label: string, color = 'ededed', description = ''): void {
  try {
    gh(['label', 'create', label, '--color', color, '--description', description, '--force'], { repo });
  } catch {
    // already exists is fine
  }
}

// ── Sync helpers ──────────────────────────────────────────────────────────────

export interface SyncAction {
  action: 'create' | 'close' | 'reopen' | 'skip';
  task_slug: string;
  issue_number?: number;
  reason: string;
}

/**
 * Reconcile DB tasks against GH issues.
 * Returns a list of actions; apply=false is dry-run.
 */
export function syncTasks(
  repo: string,
  tasks: Array<{ id: number; slug: string; title: string; status: string; gh_issue_number: number | null }>,
  apply: boolean = false,
): SyncAction[] {
  const actions: SyncAction[] = [];

  // Build a title→issue map from existing GH issues to avoid duplicates
  const existingIssues = listIssues(repo, 'crux');
  const issueByTitle = new Map<string, number>(existingIssues.map(i => [i.title, i.number]));

  for (const task of tasks) {
    if (task.status === 'dropped') {
      actions.push({ action: 'skip', task_slug: task.slug, reason: 'dropped tasks excluded' });
      continue;
    }

    const resolvedIssueNum = task.gh_issue_number ?? issueByTitle.get(task.title) ?? null;

    if (!resolvedIssueNum) {
      // Task has no linked issue → create one
      actions.push({ action: 'create', task_slug: task.slug, reason: 'no linked GH issue' });
      if (apply) {
        const issue = createIssue(repo, task.title, `crux task: \`${task.slug}\``, ['crux']);
        actions[actions.length - 1].issue_number = issue.number;
      }
    } else {
      if (task.gh_issue_number == null) {
        // Found by title match — record the link
        actions.push({ action: 'create', task_slug: task.slug, reason: 'linked existing issue by title', issue_number: resolvedIssueNum });
      } else if (task.status === 'done') {
        actions.push({ action: 'close', task_slug: task.slug, issue_number: resolvedIssueNum, reason: 'task is done' });
        if (apply) closeIssue(repo, resolvedIssueNum, `Closed by crux: task \`${task.slug}\` marked done.`);
      } else {
        actions.push({ action: 'skip', task_slug: task.slug, issue_number: resolvedIssueNum, reason: 'issue already open' });
      }
    }
  }

  return actions;
}

// ── Test resource teardown ────────────────────────────────────────────────────

export function teardownTestIssues(repo: string): void {
  const issues = listIssues(repo, 'pm-test');
  for (const issue of issues) {
    try {
      closeIssue(repo, issue.number);
    } catch { /* best effort */ }
  }
}
