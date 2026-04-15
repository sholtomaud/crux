# ADR-002: MCP stdio transport — stdout is exclusively the JSON-RPC channel

**Status:** accepted  
**Date:** 2026-04-15

## Context

crux must act as an MCP server for AI assistants (Claude, local LLMs). HTTP-based MCP introduces port management and lifecycle complexity for a local-first tool. The MCP SDK uses stdio transport by default.

## Decision

Use MCP stdio transport. All JSON-RPC messages flow through stdout exclusively. Any non-JSON-RPC output (logs, startup messages, UI server URL) must use process.stderr.write — never console.log or process.stdout.write. The HTTP UI server runs on port 8765 in the background but is separate from the MCP channel.

## Consequences

stdout pollution breaks the MCP connection immediately. All library code and server startup must be audited for console.log calls. Debugging is stderr-only. The constraint is strict but the benefit is zero port configuration for the MCP client.