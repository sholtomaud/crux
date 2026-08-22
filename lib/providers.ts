/**
 * lib/providers.ts — LLM provider registry (ADR-010)
 *
 * Every provider answers the same request shape and returns the model's output
 * *paired with* what it cost. Usage is part of the return type, not an optional
 * side channel: a provider that cannot report tokens returns nulls explicitly,
 * so the gap stays visible in `agent_runs` instead of being averaged over.
 *
 * crux never fabricates cost. `cost_usd` comes from configured per-token
 * pricing, or is 0 for local inference (no marginal API spend). Otherwise it is
 * null. A capital model fed invented dollars is worse than one with gaps.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Wire types ────────────────────────────────────────────────────────────────

export interface LlmMessage {
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

/** What one call consumed. Nulls mean "not reported", never "zero". */
export interface LlmUsage {
  input_tokens:  number | null;
  output_tokens: number | null;
  cost_usd:      number | null;
  model:         string | null;
}

export interface LlmRequest {
  messages:     LlmMessage[];
  model?:       string;
  max_tokens?:  number;
  temperature?: number;
  tools?:       unknown[];
  tool_choice?: string;
}

export interface LlmResponse {
  message:       LlmMessage | null;
  finish_reason: string | null;
  usage:         LlmUsage;
}

/** Vendor list price, in dollars per million tokens. */
export interface Pricing {
  input_per_1m:  number;
  output_per_1m: number;
}

export interface ProviderConfig {
  endpoint:    string;
  model:       string;
  /** Env var holding the bearer token. Named, not inlined — config.json is not a secret store. */
  api_key_env?: string;
  /** Local inference: real tokens, no marginal dollar cost. */
  local?:      boolean;
  pricing?:    Pricing;
  max_tokens?: number;
  ctx_tokens?: number;
}

export interface Provider {
  readonly name: string;
  readonly config: ProviderConfig;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

// ── Cost ──────────────────────────────────────────────────────────────────────

/**
 * Dollar cost for a call, or null when it genuinely isn't known.
 *
 * Configured pricing wins. Failing that, local inference is 0 — correct, and
 * true whether or not tokens were counted. Everything else is null: an
 * unpriced remote model has a real cost crux cannot compute, and guessing it
 * would poison the capital model.
 */
export function computeCost(
  inputTokens:  number | null,
  outputTokens: number | null,
  cfg: ProviderConfig,
): number | null {
  if (cfg.pricing) {
    if (inputTokens === null && outputTokens === null) return null;
    const cost = (inputTokens  ?? 0) / 1e6 * cfg.pricing.input_per_1m
               + (outputTokens ?? 0) / 1e6 * cfg.pricing.output_per_1m;
    return Math.round(cost * 1e6) / 1e6;
  }
  if (cfg.local) return 0;
  return null;
}

// ── OpenAI-compatible provider ────────────────────────────────────────────────

/** Coerce a wire value to a token count, rejecting the non-numbers servers send. */
function tokenCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Chat-completions over the OpenAI wire format — llama-server, Ollama,
 * LM Studio, OpenAI itself, and anything else speaking that dialect.
 */
export function openAiCompatible(name: string, cfg: ProviderConfig): Provider {
  return {
    name,
    config: cfg,

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const key = cfg.api_key_env ? process.env[cfg.api_key_env] : undefined;
      if (key) headers['Authorization'] = `Bearer ${key}`;

      const body: Record<string, unknown> = {
        model:    req.model ?? cfg.model,
        messages: req.messages,
      };
      if (req.max_tokens  !== undefined) body.max_tokens  = req.max_tokens;
      else if (cfg.max_tokens !== undefined) body.max_tokens = cfg.max_tokens;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.tools)       body.tools       = req.tools;
      if (req.tool_choice) body.tool_choice = req.tool_choice;

      let resp: Response;
      try {
        resp = await fetch(cfg.endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (err: unknown) {
        throw new Error(
          `Cannot reach LLM provider '${name}' at ${cfg.endpoint}. Is it running?\n${(err as Error).message}`
        );
      }

      if (!resp.ok) {
        throw new Error(`Provider '${name}' returned HTTP ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as {
        choices?: Array<{ message?: LlmMessage; finish_reason?: string }>;
        usage?:   { prompt_tokens?: unknown; completion_tokens?: unknown };
        model?:   string;
        error?:   { message?: string };
      };

      if (data.error) throw new Error(`Provider '${name}' error: ${data.error.message}`);

      const input  = tokenCount(data.usage?.prompt_tokens);
      const output = tokenCount(data.usage?.completion_tokens);
      const choice = data.choices?.[0];

      return {
        message:       choice?.message ?? null,
        finish_reason: choice?.finish_reason ?? null,
        usage: {
          input_tokens:  input,
          output_tokens: output,
          cost_usd:      computeCost(input, output, cfg),
          model:         data.model ?? cfg.model,
        },
      };
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

type ProviderFactory = (name: string, cfg: ProviderConfig) => Provider;

const _factories = new Map<string, ProviderFactory>([
  ['openai-compatible', openAiCompatible],
]);

/** Register a provider kind. Kinds are wire dialects; instances are config. */
export function registerProviderKind(kind: string, factory: ProviderFactory): void {
  _factories.set(kind, factory);
}

export function providerKinds(): string[] {
  return [..._factories.keys()].sort();
}

// ── Config resolution ─────────────────────────────────────────────────────────

interface LegacyLlmConfig {
  endpoint?: string;
  model?: string;
  max_tokens?: number;
  ctx_tokens?: number;
}

interface CruxProviderFile {
  llm?: LegacyLlmConfig;
  providers?: Record<string, ProviderConfig & { kind?: string }>;
  default_provider?: string;
}

export const DEFAULT_ENDPOINT = 'http://localhost:8080/v1/chat/completions';

function readConfigFile(): CruxProviderFile {
  const path = join(homedir(), '.crux', 'config.json');
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')) as CruxProviderFile; }
  catch { return {}; }
}

/**
 * Resolve a named provider from `~/.crux/config.json`.
 *
 * With no `providers` block, the pre-ADR-010 `llm` config is synthesised into a
 * single local provider — existing installs keep working and start reporting
 * tokens without touching their config.
 */
export function resolveProvider(name?: string): Provider {
  const file = readConfigFile();
  const wanted = name ?? file.default_provider ?? 'local';

  const entry = file.providers?.[wanted];
  if (entry) {
    const kind    = entry.kind ?? 'openai-compatible';
    const factory = _factories.get(kind);
    if (!factory) {
      throw new Error(`Unknown provider kind '${kind}' for provider '${wanted}' (known: ${providerKinds().join(', ')})`);
    }
    return factory(wanted, entry);
  }

  // No providers block: fall back to the legacy single-endpoint config.
  if (name && name !== 'local') {
    throw new Error(
      `Provider '${name}' is not defined in ~/.crux/config.json. Add it under "providers".`
    );
  }
  const llm = file.llm ?? {};
  return openAiCompatible('local', {
    endpoint:   llm.endpoint ?? DEFAULT_ENDPOINT,
    model:      llm.model    ?? 'local',
    max_tokens: llm.max_tokens,
    ctx_tokens: llm.ctx_tokens,
    local:      true,
  });
}
