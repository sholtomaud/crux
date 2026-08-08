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

const STYLED_FILES = ['index.html', 'project.html', 'graph.html', 'roi.html', 'db.html', 'app.js', 'theme.js'];
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

// ── Theming ───────────────────────────────────────────────────────────────────

const TOKENS = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8');

/** Body of the last `selector { ... }` block matching `pattern`. */
function blockBody(css: string, pattern: RegExp): string {
  const m = css.match(pattern);
  assert.ok(m, `block not found: ${pattern}`);
  return m![1];
}

function tokensIn(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, k, v] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(k, v.trim());
  return out;
}

const rootTokens  = tokensIn(blockBody(TOKENS, /\n:root \{\n([\s\S]*?)\n\}/));
const darkMedia   = tokensIn(blockBody(TOKENS, /:root:not\(\[data-theme="light"\]\)\s*\{\n([\s\S]*?)\n  \}/));
const darkExplicit = tokensIn(blockBody(TOKENS, /:root\[data-theme="dark"\]\s*\{\n([\s\S]*?)\n\}/));

describe('light and dark themes', () => {
  test('the two dark blocks are identical', () => {
    // They must be kept in lockstep by hand; drift would mean the OS-driven dark
    // theme and the explicitly chosen one quietly disagree.
    assert.deepEqual([...darkMedia].sort(), [...darkExplicit].sort());
  });

  test('no token is defined only inside a media or [data-theme] block', () => {
    // Such a token would be undefined for anyone the block does not match.
    const orphans = [...darkExplicit.keys()].filter(t => !rootTokens.has(t)).sort();
    assert.deepEqual(orphans, [], `defined only in a dark block, so undefined in light: ${orphans.join(', ')}`);
  });

  test('bare :root carries a complete palette', () => {
    assert.ok(rootTokens.size >= darkExplicit.size);
    for (const key of ['--color-bg', '--color-text', '--color-primary', '--color-graph-node-fill']) {
      assert.ok(rootTokens.has(key), `${key} missing from the base :root palette`);
    }
  });

  test('every page loads theme.js from <head>, before any body content', () => {
    for (const page of PAGES) {
      const src  = readFileSync(join(UI_DIR, page), 'utf8');
      const tag  = src.indexOf('<script src="/theme.js"></script>');
      const body = src.indexOf('<body');
      assert.ok(tag > -1, `${page} must load /theme.js`);
      assert.ok(tag < body, `${page} loads theme.js after <body> — the theme would flash before it applies`);
    }
  });

  test('theme.js is served', () => {
    assert.ok(UI_ASSETS['/theme.js'], '/theme.js missing from UI_ASSETS');
    assert.match(UI_ASSETS['/theme.js']!.mime, /javascript/);
  });

  test('the service worker precaches the theme assets', () => {
    // A page cached without them renders unstyled and unthemed.
    const sw = readFileSync(join(UI_DIR, 'sw.js'), 'utf8');
    assert.match(sw, /'\/tokens\.css'/);
    assert.match(sw, /'\/theme\.js'/);
  });
});

describe('light palette meets WCAG AA', () => {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4);

  function luminance(hex: string): number {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? [...h].map(c => c + c).join('') : h;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function ratio(fg: string, bg: string): number {
    const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  }

  const val = (t: string) => rootTokens.get(t)!;

  // Body-text tokens must clear 4.5:1 on both grounds they are used against.
  const BODY_TEXT = ['--color-text', '--color-text-muted', '--color-text-subtle',
                     '--color-text-faint', '--color-text-dim', '--color-text-dimmer',
                     '--color-primary', '--color-secondary', '--color-danger', '--color-warning',
                     '--color-executor-llm', '--color-executor-human',
                     '--color-executor-hybrid', '--color-executor-auto', '--color-wsjf'];

  for (const bg of ['--color-bg', '--color-surface-container']) {
    test(`body text clears 4.5:1 on ${bg}`, () => {
      const fails = BODY_TEXT
        .map(t => ({ t, r: ratio(val(t), val(bg)) }))
        .filter(({ r }) => r < 4.5)
        .map(({ t, r }) => `${t} ${r.toFixed(2)}:1`);
      assert.deepEqual(fails, [], `below AA on ${bg}: ${fails.join(', ')}`);
    });
  }

  test('text on a filled primary button clears 4.5:1', () => {
    assert.ok(ratio(val('--color-on-primary'), val('--color-primary')) >= 4.5);
  });
});
