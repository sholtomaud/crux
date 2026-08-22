/**
 * test/unit/ui-scripts.test.ts
 *
 * The UI ships as hand-written files with no build step and no linter pass, so
 * nothing between the editor and the browser ever parses them. A stray backtick
 * inside the CSS that app.js injects — which is a JS template literal — takes
 * the whole shell down at load: no sidebar, no theme toggle, no panel. That is
 * only visible as a wall of unrelated e2e timeouts several minutes later.
 *
 * Parsing every script here turns that into a one-second failure naming the
 * file and line.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR    = join(__dirname, '../../ui');

const SCRIPTS = ['app.js', 'theme.js', 'sw.js'];
const PAGES   = ['index.html', 'project.html', 'graph.html', 'roi.html', 'db.html'];

/** Parses without running — we want syntax errors, not a headless browser. */
function assertParses(source: string, label: string): void {
  try {
    new vm.Script(source, { filename: label });
  } catch (e) {
    assert.fail(`${label} does not parse: ${(e as Error).message}`);
  }
}

/** Inline <script> bodies only; `<script src=…>` has no content to check. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1])
    .filter(s => s.trim() !== '');
}

describe('every UI script parses', () => {
  for (const file of SCRIPTS) {
    test(file, () => assertParses(readFileSync(join(UI_DIR, file), 'utf8'), file));
  }

  for (const page of PAGES) {
    test(`${page} inline scripts`, () => {
      const blocks = inlineScripts(readFileSync(join(UI_DIR, page), 'utf8'));
      blocks.forEach((src, i) => assertParses(src, `${page} <script> #${i + 1}`));
    });
  }
});

describe('the service worker cache version tracks the assets it precaches', () => {
  /**
   * sw.js is cache-first for its STATIC list: no revalidation, no max-age. An
   * asset that changes without a CACHE bump is served from the old cache
   * forever, and only for people who already have the app installed — so it is
   * invisible in development, where a hard refresh hides it, and shows up as
   * "the new feature isn't there" from users.
   *
   * That is exactly how the status outlines shipped broken once: graph.html is
   * not precached so it arrived fresh, referencing --color-status-* tokens
   * against a cached tokens.css that predated them.
   *
   * When this fails: bump CACHE in ui/sw.js, then update PRECACHED_DIGEST here.
   * Both edits are the point — the second is what makes the first deliberate.
   */
  const SW = readFileSync(join(UI_DIR, 'sw.js'), 'utf8');

  // Recorded against CACHE = 'crux-v4'.
  const PRECACHED_DIGEST = '9c038fb0f66ee62e';

  const staticList = (): string[] => {
    const m = SW.match(/const STATIC\s*=\s*\[([^\]]*)\]/);
    assert.ok(m, 'could not find the STATIC precache list in sw.js');
    return [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  };

  // '/' is index.html; the rest map to a file of the same name.
  const fileFor = (route: string) => join(UI_DIR, route === '/' ? 'index.html' : route.replace(/^\//, ''));

  test('every precached route maps to a real file', () => {
    const missing = staticList().filter(r => !existsSync(fileFor(r)));
    assert.deepEqual(missing, [], `sw.js precaches routes with no file: ${missing.join(', ')}`);
  });

  test('the precached assets are unchanged since the last CACHE bump', () => {
    const h = createHash('sha256');
    for (const route of staticList()) h.update(readFileSync(fileFor(route)));
    const digest = h.digest('hex').slice(0, 16);

    const cacheName = SW.match(/const CACHE\s*=\s*'([^']+)'/)?.[1];
    assert.equal(
      digest, PRECACHED_DIGEST,
      `precached assets changed. Bump CACHE in ui/sw.js (currently '${cacheName}') ` +
      `and set PRECACHED_DIGEST in this test to '${digest}'.`,
    );
  });
});

describe('the shell and the pages do not fight over globals', () => {
  // app.js declares its helpers with `const`/`function` at top level, and a page
  // that re-declares one of those names is a SyntaxError that kills the page —
  // the failure mode that removing project.html's own TASK_STATUSES fixed.
  const topLevelNames = (src: string): Set<string> => {
    const names = new Set<string>();
    for (const [, , name] of src.matchAll(/^(const|let|function)\s+([A-Za-z_$][\w$]*)/gm)) names.add(name);
    return names;
  };

  const appNames = topLevelNames(readFileSync(join(UI_DIR, 'app.js'), 'utf8'));

  for (const page of PAGES) {
    test(`${page} redeclares nothing app.js already owns`, () => {
      const html = readFileSync(join(UI_DIR, page), 'utf8');
      if (!html.includes('src="/app.js"')) return; // page does not load the shell

      const clashes = inlineScripts(html)
        .flatMap(src => [...topLevelNames(src)])
        .filter(n => appNames.has(n))
        .sort();

      assert.deepEqual(clashes, [], `${page} re-declares app.js globals: ${clashes.join(', ')}`);
    });
  }
});
