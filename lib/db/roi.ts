/**
 * lib/db/roi.ts — ROI records: insert, summarise, and time-to-first-dollar
 */

import { DatabaseSync } from 'node:sqlite';

import type { RoiKind } from './types.ts';

export function insertRoi(
  db: DatabaseSync,
  opts: { project_id: string; amount: number; kind: RoiKind; currency?: string; probability?: number; note?: string }
): void {
  db.prepare(`
    INSERT INTO roi_records (project_id, amount, kind, currency, probability, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.project_id,
    opts.amount,
    opts.kind,
    opts.currency ?? 'AUD',
    opts.probability ?? 1.0,
    opts.note ?? null,
  );
}

export function roiSummary(
  db: DatabaseSync,
  projectId: string
): { revenue: number; cost: number; expected: number } {
  const rows = db.prepare(`
    SELECT kind, SUM(amount * probability) as total
    FROM roi_records WHERE project_id = ?
    GROUP BY kind
  `).all(projectId) as Array<{ kind: string; total: number }>;
  const out = { revenue: 0, cost: 0, expected: 0 };
  for (const r of rows) out[r.kind as RoiKind] = r.total;
  return out;
}

/**
 * Returns the recorded_at timestamp of the first revenue ROI record (amount > 0)
 * for the given project, or null if no such record exists.
 */
export function firstRevenueAt(db: DatabaseSync, projectId: string): string | null {
  const row = db.prepare(`
    SELECT MIN(recorded_at) as first_at
    FROM roi_records
    WHERE project_id = ? AND kind = 'revenue' AND amount > 0
  `).get(projectId) as { first_at: string | null } | undefined;
  return row?.first_at ?? null;
}
