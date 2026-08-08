/**
 * test/unit/ui-tokens.test.ts
 *
 * The palette lives in exactly one file. A literal colour anywhere else is
 * invisible to the theme switcher and would silently stay dark when the light
 * theme lands, so the purge is guarded rather than merely performed once.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UI_ASSETS } from '../../lib/ui-assets.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR    = join(__dirname, '../../ui');

const STYLED_FILES = ['index.html', 'project.html', 'graph.html', 'roi.html', 'db.html', 'app.js'];
const PAGES        = ['index.html', 'project.html', 'graph.html', 'roi.html', 'db.html'];

// Deliberately not /g: a global regex carries lastIndex between .test() calls,
// which would make this check skip every other match.
const HEX = /#[0-9a-fA-F]{3,8}\b/;

/**
 * `<meta name="theme-color">` is an HTML attribute, not CSS, so it cannot hold
 * a var(). Making it follow the active theme is pi-theme-light-dark's job;
 * until then it is the one sanctioned literal outside tokens.css.
 */
const ALLOWED = /<meta name="theme-color"/;

describe('design tokens are the only place colours are declared', () => {
  for (const file of STYLED_FILES) {
    test(`${file} declares no literal colour`, () => {
      const lines = readFileSync(join(UI_DIR, file), 'utf8').split('\n');
      const offenders = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => HEX.test(line) && !ALLOWED.test(line))
        .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);

      assert.deepEqual(offenders, [], `literal colours must move into ui/tokens.css:\n${offenders.join('\n')}`);
    });
  }

  test('tokens.css defines every custom property the UI references', () => {
    const tokens = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8');
    const defined = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]));

    const referenced = new Set<string>();
    for (const file of STYLED_FILES) {
      const src = readFileSync(join(UI_DIR, file), 'utf8');
      for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) referenced.add(m[1]);
    }

    const missing = [...referenced].filter(t => !defined.has(t)).sort();
    assert.deepEqual(missing, [], `referenced but never defined in tokens.css: ${missing.join(', ')}`);
  });

  test('every page links the shared palette', () => {
    for (const page of PAGES) {
      const src = readFileSync(join(UI_DIR, page), 'utf8');
      assert.ok(
        src.includes('<link rel="stylesheet" href="/tokens.css">'),
        `${page} must link /tokens.css — graph.html in particular used to carry its own private palette`,
      );
    }
  });

  test('tokens.css is served, so the link cannot 404', () => {
    assert.ok(UI_ASSETS['/tokens.css'], '/tokens.css missing from UI_ASSETS');
    assert.match(UI_ASSETS['/tokens.css']!.mime, /^text\/css/);
    assert.ok(UI_ASSETS['/tokens.css']!.content.includes('--color-bg'));
  });
});
