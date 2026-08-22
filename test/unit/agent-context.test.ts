/**
 * test/unit/agent-context.test.ts
 *
 * crux used to hand every project its own TypeScript/SQLite house rules —
 * "create lib/db/<domain>.ts", "run make test-ci" — regardless of what the
 * project actually was. Confirmed twice in the field, on a C99 kernel and on a
 * Python repo. An agent picking up a task there was instructed to edit files
 * that do not exist and run make targets that are not defined, which is worse
 * than being told nothing: it is confidently wrong rather than merely silent.
 *
 * These fixtures are two real directories on disk, because the whole failure
 * was about reading the wrong directory.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { agentContext, resolveConventions, extractConventions } from '../../lib/codebase.ts';

/** Strings that only make sense inside crux itself. */
const CRUX_ONLY = ['lib/db.ts', 'DatabaseSync', 'make test-ci', 'make typecheck', 'lib/db/index.ts'];

let base: string;
let tsRepo: string;
let cRepo: string;
let bareRepo: string;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'crux-agent-context-'));

  // A TypeScript repo shaped like crux, with its own AGENTS.md.
  tsRepo = join(base, 'ts-project');
  mkdirSync(join(tsRepo, 'lib', 'db'), { recursive: true });
  writeFileSync(join(tsRepo, 'lib', 'db', 'widgets.ts'), 'export function listWidgets(db: DatabaseSync): void {}\n');
  writeFileSync(join(tsRepo, 'AGENTS.md'), [
    '# AGENTS.md', '',
    '## Stack', '',
    '- **Widgets** live in `lib/db/widgets.ts` and take a `DatabaseSync` first.',
    '- Run the suite with `make test-ci` before pushing.', '',
  ].join('\n'));

  // A plain C project: a Makefile and src/*.c, no TypeScript anywhere.
  cRepo = join(base, 'c-project');
  mkdirSync(join(cRepo, 'src'), { recursive: true });
  writeFileSync(join(cRepo, 'src', 'kernel.c'), 'int main(void) { return 0; }\n');
  writeFileSync(join(cRepo, 'Makefile'), 'all:\n\t$(CC) -std=c99 src/kernel.c\n');
  writeFileSync(join(cRepo, 'AGENTS.md'), [
    '# AGENTS.md', '',
    '- C99 only, freestanding — no libc.',
    '- Build with `make`; there is no package manager.',
    '- Every symbol in `src/` is prefixed `k_`.', '',
  ].join('\n'));

  // A repo with no conventions doc at all.
  bareRepo = join(base, 'bare-project');
  mkdirSync(bareRepo, { recursive: true });
  writeFileSync(join(bareRepo, 'main.py'), 'print("hi")\n');
});

after(() => rmSync(base, { recursive: true, force: true }));

describe('conventions are never crux\'s own', () => {
  test('a C project gets its own conventions, with no TypeScript strings', () => {
    const ctx = agentContext(cRepo, 'code_repo', { repo_path: cRepo });

    const joined = ctx.conventions.join(' ');
    for (const needle of CRUX_ONLY) {
      assert.ok(!joined.includes(needle), `leaked crux-specific string "${needle}" into: ${joined}`);
    }
    assert.ok(joined.includes('C99'), `expected the C project's own rules, got: ${joined}`);
    assert.equal(ctx.conventions_source, 'AGENTS.md');
  });

  test('a TypeScript project surfaces conventions traceable to its own AGENTS.md', () => {
    const ctx = agentContext(tsRepo, 'code_repo', { repo_path: tsRepo });
    assert.equal(ctx.conventions_source, 'AGENTS.md');
    assert.ok(ctx.conventions.some(c => c.includes('lib/db/widgets.ts')));
    // Every line must literally appear in that file, not be invented around it.
    for (const c of ctx.conventions) {
      assert.ok(c.length > 0 && !c.startsWith('#'), `unexpected convention line: ${c}`);
    }
  });

  test('an unlinked project returns an empty array, not a default set', () => {
    // The dangerous case: repo_path is null, so the only path available is the
    // cwd the MCP server happens to be running in — very often crux itself.
    const ctx = agentContext(process.cwd(), 'code_repo', { repo_path: null });
    assert.deepEqual(ctx.conventions, []);
    assert.equal(ctx.conventions_source, null);
  });

  test('a repo with no conventions doc returns empty rather than guessing', () => {
    const ctx = agentContext(bareRepo, 'code_repo', { repo_path: bareRepo });
    assert.deepEqual(ctx.conventions, []);
    assert.equal(ctx.conventions_source, null);
  });

  test('a repo_path that no longer exists on disk yields nothing', () => {
    const ctx = agentContext(cRepo, 'code_repo', { repo_path: join(base, 'deleted') });
    assert.deepEqual(ctx.conventions, []);
    assert.equal(ctx.conventions_source, null);
  });

  test('non-code project types get conventions too, on the same rules', () => {
    const ctx = agentContext(cRepo, 'research', { repo_path: cRepo });
    assert.equal(ctx.conventions_source, 'AGENTS.md');
    assert.ok(ctx.conventions.length > 0);
  });
});

describe('precedence: explicit config beats a derived doc', () => {
  test('.crux/project.json conventions win over AGENTS.md', () => {
    const repo = join(base, 'configured');
    mkdirSync(join(repo, '.crux'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), '- derived from the doc\n');
    writeFileSync(join(repo, '.crux', 'project.json'), JSON.stringify({
      project_id: 'x', conventions: ['authoritative rule one', 'authoritative rule two'],
    }));

    const { conventions, conventions_source } = resolveConventions(repo);
    assert.equal(conventions_source, 'project config');
    assert.deepEqual(conventions, ['authoritative rule one', 'authoritative rule two']);
  });

  test('a pointer file without a conventions key falls through to the doc', () => {
    const repo = join(base, 'pointer-only');
    mkdirSync(join(repo, '.crux'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), '- from the doc\n');
    writeFileSync(join(repo, '.crux', 'project.json'), JSON.stringify({ project_id: 'x' }));

    const { conventions, conventions_source } = resolveConventions(repo);
    assert.equal(conventions_source, 'AGENTS.md');
    assert.deepEqual(conventions, ['from the doc']);
  });

  test('malformed project.json does not throw, it falls through', () => {
    const repo = join(base, 'broken-json');
    mkdirSync(join(repo, '.crux'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), '- still readable\n');
    writeFileSync(join(repo, '.crux', 'project.json'), '{not json');

    assert.deepEqual(resolveConventions(repo).conventions, ['still readable']);
  });

  test('CLAUDE.md is used when AGENTS.md is absent', () => {
    const repo = join(base, 'claude-md');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'CLAUDE.md'), '- rule from CLAUDE.md\n');

    const { conventions, conventions_source } = resolveConventions(repo);
    assert.equal(conventions_source, 'CLAUDE.md');
    assert.deepEqual(conventions, ['rule from CLAUDE.md']);
  });
});

describe('commands come from the project, never from crux', () => {
  test('verify and test commands are reported as configured', () => {
    const ctx = agentContext(cRepo, 'code_repo', {
      repo_path: cRepo, verify_cmd: 'make -n', test_cmd: 'make check',
    });
    assert.deepEqual(ctx.commands, { verify: 'make -n', test: 'make check' });
  });

  test('unset commands are null, not a crux default', () => {
    const ctx = agentContext(cRepo, 'code_repo', { repo_path: cRepo });
    assert.deepEqual(ctx.commands, { verify: null, test: null });
  });
});

describe('extractConventions', () => {
  test('folds wrapped continuation lines into one bullet', () => {
    const out = extractConventions([
      '- first rule that keeps going',
      '  onto a second line',
      '- second rule',
    ].join('\n'));
    assert.deepEqual(out, ['first rule that keeps going onto a second line', 'second rule']);
  });

  test('strips bold and reduces links to their text', () => {
    const out = extractConventions('- **Bold** rule, see [ADR-006](docs/adr/six.md)\n');
    assert.deepEqual(out, ['Bold rule, see ADR-006']);
  });

  test('skips headings and nested detail bullets', () => {
    const out = extractConventions([
      '# Title', '', '## Section', '',
      '- top level',
      '    - nested detail',
      '', '## Another', '',
      '- also top level',
    ].join('\n'));
    assert.deepEqual(out, ['top level', 'also top level']);
  });

  test('caps the list and the length of each line', () => {
    const many = Array.from({ length: 30 }, (_, i) => `- rule ${i}`).join('\n');
    assert.equal(extractConventions(many).length, 12);

    const long = extractConventions(`- ${'x'.repeat(500)}`);
    assert.ok(long[0]!.length <= 240, `line not capped: ${long[0]!.length}`);
    assert.ok(long[0]!.endsWith('…'));
  });

  test('prose with no bullets establishes nothing', () => {
    assert.deepEqual(extractConventions('# Doc\n\nJust paragraphs of prose here.\n'), []);
  });
});
