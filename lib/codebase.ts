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

const CODE_CONVENTIONS = [
  'New DB functions: create lib/db/<domain>.ts, export from lib/db/index.ts',
  'Do NOT edit lib/db.ts — it is a one-line re-export shim',
  'All DB functions take (db: DatabaseSync, ...) as first arg',
  'Tests: node:test + node:assert/strict, in-memory DB via new DatabaseSync(":memory:")',
  'Schema changes: schema.sql AND applyMigrations() in lib/db/open.ts',
  'MCP tools: index.ts — use process.stderr.write, never console.log',
  'Verify: make typecheck | Tests: make test-ci | Never run node/npx/tsc directly',
];

export function agentContext(cwd: string = CWD, projectType: string = 'code_repo') {
  if (projectType === 'code_repo') {
    return {
      db_api:       readDbSignatures(cwd),
      test_pattern: readTestPattern(cwd),
      db_modules:   dbModuleList(cwd),
      conventions:  CODE_CONVENTIONS,
    };
  }

  // All other types: surface CONTEXT.md + file list.
  // Conventions are stored in context_records (p20) — not hardcoded here.
  return {
    context_doc:   readContextDoc(cwd),
    project_files: listProjectFiles(cwd),
  };
}
