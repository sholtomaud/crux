/**
 * lib/ui-assets.ts
 * In native Node (tests, dev): reads UI files from disk relative to this file.
 * In bundled SEA mode: esbuild plugin replaces this module with inlined content.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR   = join(_dirname, '..', 'ui');

export const UI_ASSETS: Record<string, { content: string; mime: string }> = {
  '/':             { content: readFileSync(join(UI_DIR, 'index.html'),   'utf8'), mime: 'text/html; charset=utf-8' },
  '/index.html':   { content: readFileSync(join(UI_DIR, 'index.html'),   'utf8'), mime: 'text/html; charset=utf-8' },
  '/project.html': { content: readFileSync(join(UI_DIR, 'project.html'), 'utf8'), mime: 'text/html; charset=utf-8' },
  '/roi.html':     { content: readFileSync(join(UI_DIR, 'roi.html'),     'utf8'), mime: 'text/html; charset=utf-8' },
  '/graph.html':   { content: readFileSync(join(UI_DIR, 'graph.html'),   'utf8'), mime: 'text/html; charset=utf-8' },
  '/db.html':      { content: readFileSync(join(UI_DIR, 'db.html'),      'utf8'), mime: 'text/html; charset=utf-8' },
  '/app.js':       { content: readFileSync(join(UI_DIR, 'app.js'),       'utf8'), mime: 'application/javascript; charset=utf-8' },
};
