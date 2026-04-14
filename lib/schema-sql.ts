/**
 * lib/schema-sql.ts
 * In native Node (tests, dev): reads schema.sql from disk.
 * In bundled mode: esbuild replaces this entire module with an inline string.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dirname = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_SQL = readFileSync(join(_dirname, '..', 'schema.sql'), 'utf8');
