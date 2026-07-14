/**
 * lib/db/index.ts — re-exports entire DB surface
 *
 * Import from 'lib/db.ts' (the shim) or directly from 'lib/db/index.ts'.
 * Add new domain modules here as the codebase grows.
 */

export * from './types.ts';
export * from './open.ts';
export * from './scope.ts';
export * from './projects.ts';
export * from './tasks.ts';
export * from './dependencies.ts';
export * from './sessions.ts';
export * from './roi.ts';
export * from './test-runs.ts';
export * from './audit.ts';
export * from './adrs.ts';
export * from './status.ts';
export * from './calibration.ts';
export * from './config.ts';
