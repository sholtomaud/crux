/**
 * lib/db/calibration.ts — estimation calibration (actual/estimate ratio per estimator)
 */

import { DatabaseSync } from 'node:sqlite';

import type { Task, EstimatedBy } from './types.ts';
import { tasksByProject } from './tasks.ts';

/** actual_days / duration_days for one task — null when either is unset (ratio undefined), so callers can filter rather than average in a 0. */
export function taskEstimateRatio(task: Pick<Task, 'actual_days' | 'duration_days'>): number | null {
  if (task.actual_days == null || !task.duration_days) return null;
  return task.actual_days / task.duration_days;
}

export interface CalibrationBucket {
  estimated_by: EstimatedBy;
  count: number;
  avg_ratio: number;
  min_ratio: number;
  max_ratio: number;
}

export interface CalibrationReport {
  project_id: string;
  by_estimator: CalibrationBucket[];
  overall: { count: number; avg_ratio: number } | null;
}

/**
 * Groups done-with-actuals tasks by estimated_by and computes actual/estimate
 * ratio stats. Ratio > 1 means the task took longer than estimated; < 1 means
 * it finished faster. Tasks missing actual_days or duration_days are excluded
 * (there's nothing to calibrate yet).
 */
export function calibrationByEstimator(db: DatabaseSync, projectId: string): CalibrationReport {
  const tasks = tasksByProject(db, projectId);

  const byEstimator = new Map<EstimatedBy, number[]>();
  const allRatios: number[] = [];

  for (const t of tasks) {
    const ratio = taskEstimateRatio(t);
    if (ratio === null) continue;
    if (!byEstimator.has(t.estimated_by)) byEstimator.set(t.estimated_by, []);
    byEstimator.get(t.estimated_by)!.push(ratio);
    allRatios.push(ratio);
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const by_estimator: CalibrationBucket[] = Array.from(byEstimator.entries())
    .map(([estimated_by, ratios]) => ({
      estimated_by,
      count:     ratios.length,
      avg_ratio: Math.round(avg(ratios) * 100) / 100,
      min_ratio: Math.round(Math.min(...ratios) * 100) / 100,
      max_ratio: Math.round(Math.max(...ratios) * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    project_id: projectId,
    by_estimator,
    overall: allRatios.length > 0
      ? { count: allRatios.length, avg_ratio: Math.round(avg(allRatios) * 100) / 100 }
      : null,
  };
}
