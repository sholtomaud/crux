/**
 * lib/db.ts — backwards-compatible re-export shim
 *
 * The DB layer lives in lib/db/*.ts (one file per domain).
 * This file keeps all existing import paths working without changes.
 *
 * To add a new DB function: create lib/db/<domain>.ts, export from lib/db/index.ts.
 * Do NOT add code here.
 */

export * from './db/index.ts';
