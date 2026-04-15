/**
 * lib/agent.ts — Local LLM agentic tool-call loop
 *
 * Sends a crux task to a local llama-cpp (OpenAI-compatible) server.
 * Runs a tool-call loop until the model marks the task done, gets stuck,
 * or hits the iteration limit.
 *
 * Tools exposed to the model:
 *   read_file(path)                    — read any file in the repo
 *   write_file(path, content)          — create or overwrite a file
 *   run_command(command)               — execute a shell command
 *   list_files(pattern)                — find files by glob/name pattern
 *   crux_task_update(slug, status, note?) — mark task in-progress/done/blocked
 *
 * Supports:
 *   - Native OpenAI tool_calls (Qwen3, Llama 3.3, Mistral, etc.)
 *   - JSON fallback: model embeds {"tool": "...", "arguments": {...}} in text
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './ask.ts';
import { taskBySlug, updateTaskStatus, logAudit, listAdrs, dependenciesByProject, tasksByProject } from './db.ts';
import type { Project, Task, TaskStatus } from './db.ts';

// ── Tool definitions (OpenAI function-calling schema) ─────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the project. Use relative paths from the project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root (e.g. "lib/db.ts", "index.ts")' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file and any missing directories. Use for creating or editing files.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to project root' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command. Returns stdout + stderr + exit code. Use for: npm test, tsc, grep, ls, git status.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run (runs in project root)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the project matching a pattern or in a directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'File name pattern or directory path (e.g. "lib/*.ts", "ui/", "*.sql")' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crux_task_update',
      description: 'Update the status of a crux task. Call with status=done when the task is complete, status=blocked if you cannot proceed.',
      parameters: {
        type: 'object',
        properties: {
          slug:   { type: 'string', description: 'Task slug (e.g. "p16-actual-duration")' },
          status: { type: 'string', enum: ['in-progress', 'done', 'blocked'], description: 'New status' },
          note:   { type: 'string', description: 'Brief note about what was done or what is blocking' },
        },
        required: ['slug', 'status'],
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

function executeTool(
  name: string,
  args: Record<string, string>,
  db: DatabaseSync,
  proj: Project,
  log: (s: string) => void,
): string {
  switch (name) {

    case 'read_file': {
      const p = resolve(args.path ?? '');
      try {
        const content = readFileSync(p, 'utf8');
        // Keep individual reads small — system prompt + history eats most of the budget
        return content.length > 2500 ? content.slice(0, 2500) + '\n... (truncated — use read_file with a narrower path or search for the relevant section)' : content;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    }

    case 'write_file': {
      const p = resolve(args.path ?? '');
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, args.content ?? '', 'utf8');
        return `✓ Written: ${args.path} (${(args.content ?? '').length} bytes)`;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    }

    case 'run_command': {
      const cmd = args.command ?? '';
      log(`  [run] ${cmd}`);
      const result = spawnSync('sh', ['-c', cmd], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 120_000,
      });
      const out = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
      return `exit:${result.status ?? 0}\n${out.slice(0, 3000)}`;
    }

    case 'list_files': {
      const pat = args.pattern ?? '.';
      const result = spawnSync('sh', ['-c',
        `find . -path "*/node_modules" -prune -o -path "*/.git" -prune -o \\( -name "${pat.replace(/\*\*\//g, '')}" -o -path "./${pat}" \\) -print | head -40`
      ], { cwd: process.cwd(), encoding: 'utf8' });
      return result.stdout.trim() || 'No files found';
    }

    case 'crux_task_update': {
      const { slug, status, note } = args;
      try {
        updateTaskStatus(db, proj.id, slug, status as TaskStatus);
        logAudit(db, { project_id: proj.id, event: `task.${status}`, detail: note ?? null, actor: 'crux-auto' });
        return `✓ ${slug} → ${status}${note ? `: ${note}` : ''}`;
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(task: Task, proj: Project, db: DatabaseSync): string {
  const adrs  = listAdrs(db, proj.id);
  const deps  = dependenciesByProject(db, proj.id);
  const tasks = tasksByProject(db, proj.id);
  const slugById = new Map(tasks.map(t => [t.id, t.slug]));
  const preds = deps.filter(d => d.successor_id === task.id).map(d => slugById.get(d.predecessor_id) ?? d.predecessor_id);

  return `You are an expert TypeScript/Node.js engineer completing a task in the crux project.

## Project: ${proj.name}
crux is a personal project manager CLI + MCP server. Key files:
- index.ts          — CLI entry point + MCP server (all commands + tools)
- lib/db.ts         — SQLite layer (all DB functions)
- lib/cpm.ts        — Critical Path Method computation
- lib/server.ts     — Browser UI HTTP server
- lib/ask.ts        — Local LLM routing
- lib/agent.ts      — This agent loop (you are running inside it)
- schema.sql        — DB schema (applied via applySchema in db.ts)
- ui/               — HTML/SVG browser UI pages
- esbuild.config.mjs — Build config (inlines UI files + schema)

## Architecture decisions (from ADRs):
${adrs.slice(0, 3).map(a => `- ADR-${a.number}: ${a.title}\n  ${(a.decision ?? '').slice(0, 150)}`).join('\n')}

## Your task: ${task.slug}
**Title:** ${task.title}
**Phase:** ${task.phase ?? 'unphased'}
**Description:** ${task.description ?? 'No description — infer from title.'}
**Depends on:** ${preds.length ? preds.join(', ') : 'none'}

## Instructions:
1. Read the relevant files to understand what needs changing
2. Make the required code changes using write_file
3. Run \`npm run bundle\` (inside container: \`make bundle\`) or check with \`run_command: npx tsc --noEmit\` to verify TypeScript
4. When complete, call crux_task_update(slug="${task.slug}", status="done", note="brief summary")
5. If you cannot proceed, call crux_task_update(slug="${task.slug}", status="blocked", note="reason")

## Important rules:
- Always read a file before editing it — never guess contents
- Schema changes go in schema.sql AND as ALTER TABLE in applyMigrations() in lib/db.ts
- New DB functions go in lib/db.ts, imported into index.ts
- New MCP tools go in index.ts in the runMcpServer() function
- New CLI commands go in the switch statement in runCli() in index.ts
- Do NOT use console.log in MCP server code — use process.stderr.write
- The binary is built with make sea-macos — do not try to build the SEA yourself

Respond with tool calls only. Do not explain — just act.`;
}

// ── Context window management ─────────────────────────────────────────────────

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(messages: LlmMessage[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : '';
      const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls) : '';
      return sum + content.length + toolCalls.length;
    }, 0) / 4
  );
}

/**
 * Prune the message list to stay under budget.
 * Always keeps: messages[0] (system) and messages[1] (initial user task).
 * Drops the oldest assistant+tool pairs from the middle when over budget.
 */
function pruneMessages(messages: LlmMessage[], budgetTokens: number): LlmMessage[] {
  if (estimateTokens(messages) <= budgetTokens) return messages;

  // Identify pairs: assistant message followed by one or more tool results
  // messages[0] = system, messages[1] = user — never drop these
  const head = messages.slice(0, 2);
  const tail = messages.slice(2);

  // Drop from the front of tail until under budget
  while (tail.length > 0 && estimateTokens([...head, ...tail]) > budgetTokens) {
    // Drop the first message in tail (oldest assistant or tool result)
    tail.shift();
    // If next message is a tool result, drop it too (keep role consistency)
    while (tail.length > 0 && tail[0].role === 'tool') tail.shift();
  }

  return [...head, ...tail];
}

// ── Message type ──────────────────────────────────────────────────────────────

interface LlmMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

// ── Main agent loop ───────────────────────────────────────────────────────────

export interface AgentResult {
  completed: boolean;
  blocked:   boolean;
  iterations: number;
  finalNote?: string;
}

export async function runAgent(
  db: DatabaseSync,
  proj: Project,
  taskSlug: string,
  opts: { maxIter?: number; dryRun?: boolean; ctxTokens?: number } = {},
): Promise<AgentResult> {
  const maxIter   = opts.maxIter   ?? 25;
  const dryRun    = opts.dryRun    ?? false;
  const ctxTokens = opts.ctxTokens ?? 6000; // leave ~2k headroom for response in an 8k context

  const log = (s: string) => process.stderr.write(s + '\n');

  const task = taskBySlug(db, proj.id, taskSlug);
  if (!task) throw new Error(`Task not found: ${taskSlug}`);

  const config   = loadConfig();
  const endpoint = config.llm?.endpoint ?? 'http://localhost:8080/v1/chat/completions';
  // Use the actual model name from the API if config has placeholder
  const model    = (config.llm?.model && config.llm.model !== 'llama3.2' && config.llm.model !== 'local')
    ? config.llm.model
    : 'bartowski/Qwen_Qwen3.5-35B-A3B-GGUF:Q4_K_M';

  log(`\ncrux agent → ${task.slug}`);
  log(`title:    ${task.title}`);
  log(`model:    ${model}`);
  log(`endpoint: ${endpoint}`);
  log(`max iter: ${maxIter}\n`);

  if (dryRun) {
    log('[dry-run] system prompt:');
    log(buildSystemPrompt(task, proj, db));
    return { completed: false, blocked: false, iterations: 0 };
  }

  // Mark in-progress
  updateTaskStatus(db, proj.id, taskSlug, 'in-progress');
  logAudit(db, { project_id: proj.id, task_id: task.id, event: 'task.in-progress', detail: 'started by crux agent', actor: 'crux-auto' });

  const messages: LlmMessage[] = [
    { role: 'system',  content: buildSystemPrompt(task, proj, db) },
    { role: 'user',    content: `Complete this task now: ${task.slug} — ${task.title} /no_think` },
  ];

  let completed = false;
  let blocked   = false;
  let finalNote: string | undefined;
  let iter = 0;

  while (!completed && !blocked && iter < maxIter) {
    iter++;
    log(`\n[iter ${iter}/${maxIter}] → ${model}`);

    const pruned = pruneMessages(messages, ctxTokens);
    if (pruned.length < messages.length) {
      log(`  [ctx] pruned ${messages.length - pruned.length} old messages (est. ${estimateTokens(messages)} → ${estimateTokens(pruned)} tokens)`);
    }

    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: pruned,
          tools: TOOLS,
          tool_choice: 'auto',
          temperature: 0.1,
          max_tokens:  2048,
        }),
      });
    } catch (e) {
      log(`fetch error: ${(e as Error).message}`);
      break;
    }

    if (!resp.ok) {
      log(`HTTP ${resp.status}: ${await resp.text()}`);
      break;
    }

    const data = await resp.json() as {
      choices?: Array<{ message: LlmMessage; finish_reason: string }>;
      error?: { message: string };
    };

    if (data.error) { log(`LLM error: ${data.error.message}`); break; }
    const choice = data.choices?.[0];
    if (!choice) { log('No response choices'); break; }

    const msg = choice.message;

    // Strip Qwen3 thinking tokens from content
    if (msg.content) {
      msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
    }

    messages.push(msg);

    // ── Native tool calls ─────────────────────────────────────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let toolArgs: Record<string, string> = {};
        try { toolArgs = JSON.parse(tc.function.arguments); } catch { /* bad JSON */ }

        const shortArgs = JSON.stringify(toolArgs).slice(0, 120);
        log(`  ▶ ${tc.function.name}(${shortArgs})`);

        const result = executeTool(tc.function.name, toolArgs, db, proj, log);
        log(`  ◀ ${result.slice(0, 200)}`);

        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });

        if (tc.function.name === 'crux_task_update') {
          if (toolArgs.status === 'done')    { completed = true; finalNote = toolArgs.note; }
          if (toolArgs.status === 'blocked') { blocked   = true; finalNote = toolArgs.note; }
        }
      }
      continue;
    }

    // ── JSON fallback (model didn't use native tool_calls) ────────────────────
    if (msg.content) {
      log(`  model text: ${msg.content.slice(0, 300)}`);

      // Try to extract {"tool": "...", "arguments": {...}} from text
      const jsonMatch = msg.content.match(/\{[\s\S]*"tool"[\s\S]*"arguments"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { tool: string; arguments: Record<string, string> };
          log(`  [json-fallback] ${parsed.tool}`);
          const result = executeTool(parsed.tool, parsed.arguments, db, proj, log);
          log(`  ◀ ${result.slice(0, 200)}`);
          messages.push({ role: 'user', content: `Tool result (${parsed.tool}):\n${result}\n\nContinue.` });
          if (parsed.tool === 'crux_task_update') {
            if (parsed.arguments.status === 'done')    { completed = true; finalNote = parsed.arguments.note; }
            if (parsed.arguments.status === 'blocked') { blocked   = true; finalNote = parsed.arguments.note; }
          }
          continue;
        } catch { /* not parseable */ }
      }
    }

    // ── Model finished without tool calls — stop ──────────────────────────────
    if (choice.finish_reason === 'stop') {
      log('\nModel stopped without tool calls.');
      if (msg.content) log(`Final message: ${msg.content.slice(0, 500)}`);
      break;
    }
  }

  const reason = completed ? '✓ done' : blocked ? '⊘ blocked' : iter >= maxIter ? '⚠ max iterations' : '· stopped';
  log(`\n${reason}: ${taskSlug}${finalNote ? ` — ${finalNote}` : ''}`);

  return { completed, blocked, iterations: iter, finalNote };
}
