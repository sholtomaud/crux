/**
 * lib/codebase.ts — project grounding helpers
 *
 * Shared between lib/workflow.ts (local LLM agent) and index.ts (MCP tools).
 * Returns agent_context shaped for the project type. Code repos get live API
 * signatures + test patterns. All other types get the CONTEXT.md doc + file list
 * (conventions live in the DB via context_records, not hardcoded here).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CWD = process.cwd();

// ── Code repo helpers ──────────────────────────────────────────────────────

/** Extract export signatures from lib/db/*.ts domain modules */
export function readDbSignatures(cwd: string = CWD): string {
  const dbDir = join(cwd, 'lib', 'db');
  if (existsSync(dbDir)) {
    const domainFiles = readdirSync(dbDir)
      .filter(f => f.endsWith('.ts') && f !== 'index.ts')
      .sort();
    const sigs: string[] = [];
    for (const f of domainFiles) {
      const lines = readFileSync(join(dbDir, f), 'utf8').split('\n');
      const exports = lines.filter(l =>
        l.startsWith('export function') || l.startsWith('export interface') ||
        l.startsWith('export type') || l.startsWith('export const')
      );
      if (exports.length) {
        sigs.push(`// lib/db/${f}`);
        sigs.push(...exports);
      }
    }
    return sigs.join('\n').slice(0, 3000);
  }
  // fallback: monolith
  const p = join(cwd, 'lib', 'db.ts');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8').split('\n')
    .filter(l => l.startsWith('export function') || l.startsWith('export interface') ||
                 l.startsWith('export type') || l.startsWith('export const'))
    .join('\n').slice(0, 3000);
}

/** Read one existing unit test as a concrete pattern example */
export function readTestPattern(cwd: string = CWD): string {
  const unitDir = join(cwd, 'test', 'unit');
  if (!existsSync(unitDir)) return '';
  const files = readdirSync(unitDir).filter(f => f.endsWith('.test.ts'));
  if (!files.length) return '';
  return readFileSync(join(unitDir, files[0]), 'utf8').slice(0, 2000);
}

/** List all lib/db domain module paths */
export function dbModuleList(cwd: string = CWD): string[] {
  const dbDir = join(cwd, 'lib', 'db');
  if (!existsSync(dbDir)) return [];
  return readdirSync(dbDir)
    .filter(f => f.endsWith('.ts') && f !== 'index.ts')
    .map(f => `lib/db/${f}`);
}

// ── Generic helpers ────────────────────────────────────────────────────────

/** Read CONTEXT.md (or common variants) from project root if present */
export function readContextDoc(cwd: string = CWD): string {
  for (const name of ['CONTEXT.md', 'context.md', 'BRIEF.md', 'brief.md']) {
    const p = join(cwd, name);
    if (existsSync(p)) return readFileSync(p, 'utf8').slice(0, 3000);
  }
  return '';
}

/** List source files in the project root (non-recursive, by extension) */
export function listProjectFiles(cwd: string = CWD): string[] {
  const skip = new Set(['.git', 'node_modules', 'dist', '.crux']);
  try {
    return readdirSync(cwd)
      .filter(f => !skip.has(f) && !f.startsWith('.') && f.includes('.'))
      .sort();
  } catch { return []; }
}

// ── Structured context for LLM orientation — type-aware ───────────────────

export type ConventionsSource = 'project config' | 'AGENTS.md' | 'CLAUDE.md' | null;

/** Docs an agent-facing repo is expected to keep its house rules in, in order. */
const CONVENTION_DOCS = ['AGENTS.md', 'CLAUDE.md'] as const;

const MAX_CONVENTIONS = 12;
const MAX_CONVENTION_LEN = 240;

/**
 * Pulls top-level bullets out of a markdown doc. Deliberately literal: every
 * string returned is a line that exists in the file, so "traceable to that
 * file" is checkable rather than a claim.
 */
export function extractConventions(markdown: string): string[] {
  const out: string[] = [];
  let current: string | null = null;

  const flush = () => {
    if (current === null) return;
    const clean = current
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean) out.push(clean.length > MAX_CONVENTION_LEN ? clean.slice(0, MAX_CONVENTION_LEN - 1) + '\u2026' : clean);
    current = null;
  };

  for (const line of markdown.split('\n')) {
    // Any bullet ends the previous one. An indented bullet is nested detail and
    // is dropped — folding it in as continuation glued sub-points onto parents.
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      flush();
      if (bullet[1].length <= 1) current = bullet[2];
      continue;
    }
    if (/^\s*#/.test(line) || line.trim() === '') { flush(); continue; }
    if (current !== null && /^\s+\S/.test(line)) { current += ' ' + line.trim(); continue; }
    flush();
  }
  flush();

  return out.slice(0, MAX_CONVENTIONS);
}

/** Optional `conventions` array in <repoPath>/.crux/project.json — authoritative. */
function readConfiguredConventions(repoPath: string): string[] | null {
  const p = join(repoPath, '.crux', 'project.json');
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8')) as { conventions?: unknown };
    if (!Array.isArray(data.conventions)) return null;
    const list = data.conventions.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
    return list.length ? list.slice(0, MAX_CONVENTIONS) : null;
  } catch { return null; }
}

/**
 * Resolve a project's conventions, in precedence order:
 *   1. explicit `.crux/project.json` config — authoritative, not inferred
 *   2. bullets from AGENTS.md / CLAUDE.md at the repo root
 *   3. nothing
 *
 * `repoPath` must be the path the project is genuinely linked to. It is not
 * defaulted to the caller's cwd on purpose: for an unlinked project the cwd is
 * whatever directory the MCP server happens to be running in — very often the
 * crux repo itself — and deriving "the project's conventions" from that is how
 * crux came to hand its own TypeScript rules to a C99 kernel and a Python repo.
 */
export function resolveConventions(repoPath: string | null | undefined): {
  conventions: string[];
  conventions_source: ConventionsSource;
} {
  if (!repoPath || !existsSync(repoPath)) return { conventions: [], conventions_source: null };

  const configured = readConfiguredConventions(repoPath);
  if (configured) return { conventions: configured, conventions_source: 'project config' };

  for (const name of CONVENTION_DOCS) {
    const p = join(repoPath, name);
    if (!existsSync(p)) continue;
    const found = extractConventions(readFileSync(p, 'utf8'));
    if (found.length) return { conventions: found, conventions_source: name };
  }

  return { conventions: [], conventions_source: null };
}

export interface ProjectGrounding {
  /** Where the project actually lives. Null when unlinked — see resolveConventions. */
  repo_path?: string | null;
  /** From the projects table: what this project runs, not what crux runs. */
  verify_cmd?: string | null;
  test_cmd?: string | null;
}

export function agentContext(
  cwd: string = CWD,
  projectType: string = 'code_repo',
  project: ProjectGrounding = {},
) {
  // Commands are structured per-project config, so they are reported as
  // commands rather than folded into prose. Null means "not configured" —
  // crux must not guess a build command for a repo it knows nothing about,
  // which is what the old hardcoded "make typecheck / make test-ci" line did.
  const commands = {
    verify: project.verify_cmd ?? null,
    test:   project.test_cmd ?? null,
  };
  const { conventions, conventions_source } = resolveConventions(project.repo_path);

  if (projectType === 'code_repo') {
    return {
      db_api:       readDbSignatures(cwd),
      test_pattern: readTestPattern(cwd),
      db_modules:   dbModuleList(cwd),
      conventions,
      conventions_source,
      commands,
    };
  }

  return {
    context_doc:   readContextDoc(cwd),
    project_files: listProjectFiles(cwd),
    conventions,
    conventions_source,
    commands,
  };
}
