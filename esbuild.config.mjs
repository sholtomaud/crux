import esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Replace lib/schema-sql.ts with an inlined string at bundle time.
const inlineSchemaPlugin = {
  name: 'inline-schema',
  setup(build) {
    build.onLoad({ filter: /lib\/schema-sql\.ts$/ }, () => ({
      contents: `export const SCHEMA_SQL = ${JSON.stringify(readFileSync(resolve('schema.sql'), 'utf8'))};`,
      loader: 'js',
    }));
  },
};

// Replace lib/ui-assets.ts with all UI files inlined as strings at bundle time.
const inlineUiPlugin = {
  name: 'inline-ui',
  setup(build) {
    build.onLoad({ filter: /lib\/ui-assets\.ts$/ }, () => {
      const files = [
        { key: '/',             path: 'ui/index.html',   mime: 'text/html; charset=utf-8' },
        { key: '/index.html',   path: 'ui/index.html',   mime: 'text/html; charset=utf-8' },
        { key: '/project.html', path: 'ui/project.html', mime: 'text/html; charset=utf-8' },
        { key: '/roi.html',     path: 'ui/roi.html',     mime: 'text/html; charset=utf-8' },
        { key: '/graph.html',   path: 'ui/graph.html',   mime: 'text/html; charset=utf-8' },
        { key: '/db.html',      path: 'ui/db.html',      mime: 'text/html; charset=utf-8' },
        { key: '/app.js',       path: 'ui/app.js',       mime: 'application/javascript; charset=utf-8' },
      ];
      const entries = files.map(f =>
        `${JSON.stringify(f.key)}: { content: ${JSON.stringify(readFileSync(resolve(f.path), 'utf8'))}, mime: ${JSON.stringify(f.mime)} }`
      ).join(',\n  ');
      return {
        contents: `export const UI_ASSETS = {\n  ${entries}\n};`,
        loader: 'js',
      };
    });
  },
};

await esbuild.build({
  entryPoints: ['index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node25',
  format: 'cjs',
  external: ['node:*'],
  // import.meta.url is ESM-only; replace with a __filename-based equivalent in CJS output
  banner: {
    js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': '__importMetaUrl',
  },
  plugins: [inlineSchemaPlugin, inlineUiPlugin],
  outfile: 'dist/crux.cjs',
});
