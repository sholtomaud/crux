# ADR-003: Three-tier routing: CLI → local LLM → Claude MCP

**Status:** accepted  
**Date:** 2026-04-15

## Context

The project needs to balance cost, privacy, and capability. Local inference is preferred for speed and cost. Not all queries justify a paid API call. Some tasks require model capability that only a large cloud model provides.

## Decision

Route by complexity and cost. Tier 1: CLI commands (free, instant) for all structured operations — status, task updates, sync, reports. Tier 2: local LLM via llama-cpp OpenAI-compatible API (free, private) for natural language queries and simple reasoning. Tier 3: Claude MCP (paid, cloud) for architecture decisions, complex planning, and code generation. A SKILL.md embedded in the binary instructs the AI to apply this routing before every action.

## Consequences

Users pay only for complex tasks. Local inference provides offline capability and privacy for sensitive project data. Routing logic must be conservative — local model capability varies by hardware. Escalation path from Tier 2 to Tier 3 must be explicit (model signals stuck or returns no tool calls).