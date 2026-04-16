/**
 * lib/db/adrs.ts — Architecture Decision Records
 */

import { DatabaseSync } from 'node:sqlite';

import type { Adr } from './types.ts';

export function insertAdr(
  db: DatabaseSync,
  opts: {
    project_id: string;
    title: string;
    context?: string;
    decision?: string;
    consequences?: string;
    status?: Adr['status'];
  }
): Adr {
  const next = (db.prepare(
    'SELECT COALESCE(MAX(number),0)+1 AS n FROM adrs WHERE project_id = ?'
  ).get(opts.project_id) as { n: number }).n;
  db.prepare(`
    INSERT INTO adrs (project_id, number, title, status, context, decision, consequences)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.project_id,
    next,
    opts.title,
    opts.status ?? 'accepted',
    opts.context ?? null,
    opts.decision ?? null,
    opts.consequences ?? null,
  );
  return db.prepare(
    'SELECT * FROM adrs WHERE project_id = ? AND number = ?'
  ).get(opts.project_id, next) as unknown as Adr;
}

export function listAdrs(db: DatabaseSync, projectId: string): Adr[] {
  return db.prepare(
    'SELECT * FROM adrs WHERE project_id = ? ORDER BY number'
  ).all(projectId) as unknown as Adr[];
}
