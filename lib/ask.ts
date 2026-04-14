/**
 * lib/ask.ts — Route a natural-language question to a local LLM
 * with DB context automatically injected.
 *
 * Compatible with llama-server, Ollama, LM Studio — anything OpenAI-compatible.
 * Single fetch() call. Zero npm deps.
 */

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tasksByProject, roiSummary, totalHours, projectStatus } from './db.ts';
import type { Project } from './db.ts';

// ── Config ────────────────────────────────────────────────────────────────────

interface LlmConfig {
  endpoint: string;
  model: string;
  max_tokens: number;
}

interface CruxConfig {
  llm?: LlmConfig;
  hourly_rate?: number;
}

const DEFAULT_LLM: LlmConfig = {
  endpoint:   'http://localhost:8080/v1/chat/completions',
  model:      'llama3.2',
  max_tokens: 512,
};

export function loadConfig(): CruxConfig {
  const path = join(homedir(), '.crux', 'config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CruxConfig;
  } catch { return {}; }
}

// ── Context builder ───────────────────────────────────────────────────────────

function buildContext(db: DatabaseSync, project: Project): string {
  const status = projectStatus(db, project.id);
  const roi    = roiSummary(db, project.id);
  const hours  = totalHours(db, project.id);
  const tasks  = tasksByProject(db, project.id);

  const criticalTasks = tasks.filter(t => t.is_critical && t.status !== 'done');
  const blockedTasks  = tasks.filter(t => t.status === 'blocked');
  const inProgress    = tasks.filter(t => t.status === 'in-progress');

  return [
    `Project: ${project.name} (${project.type}, ${project.status})`,
    `Tasks: ${status.total} total, ${status.done} done, ${status.open} open, ${status.in_progress} in-progress, ${status.blocked} blocked`,
    `Hours invested: ${hours.toFixed(1)}h`,
    `Revenue: $${roi.revenue.toFixed(0)} | Cost: $${roi.cost.toFixed(0)} | Expected: $${roi.expected.toFixed(0)}`,
    criticalTasks.length > 0 ? `Critical path (open): ${criticalTasks.map(t => t.slug).join(' → ')}` : 'No open critical tasks.',
    blockedTasks.length > 0  ? `Blocked: ${blockedTasks.map(t => t.slug).join(', ')}` : '',
    inProgress.length > 0    ? `In progress: ${inProgress.map(t => t.slug).join(', ')}` : '',
    status.next_unblocked.length > 0
      ? `Next unblocked: ${status.next_unblocked.map((t: { slug: string }) => t.slug).join(', ')}`
      : '',
  ].filter(Boolean).join('\n');
}

// ── Ask ───────────────────────────────────────────────────────────────────────

export async function ask(db: DatabaseSync, project: Project, question: string): Promise<string> {
  const config = loadConfig();
  const llm    = config.llm ?? DEFAULT_LLM;
  const ctx    = buildContext(db, project);

  const body = {
    model: llm.model,
    max_tokens: llm.max_tokens,
    messages: [
      {
        role: 'system',
        content: 'You are a project management assistant. Answer concisely using the project context provided. Focus on actionable insights.',
      },
      {
        role: 'user',
        content: `Project context:\n${ctx}\n\nQuestion: ${question}`,
      },
    ],
  };

  let resp: Response;
  try {
    resp = await fetch(llm.endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err: unknown) {
    throw new Error(
      `Cannot reach local LLM at ${llm.endpoint}. Is llama-server/Ollama running?\n${(err as Error).message}`
    );
  }

  if (!resp.ok) {
    throw new Error(`LLM returned HTTP ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) throw new Error(`LLM error: ${data.error.message}`);
  return data.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}
