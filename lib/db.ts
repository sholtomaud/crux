/**
 * lib/db.ts — SQLite layer using node:sqlite (Node 25 stdlib)
 * Single global DB at ~/.crux/crux.db
 * Per-repo scoping via .crux/project.json
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SCHEMA_SQL } from './schema-sql.ts';


