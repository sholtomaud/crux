/**
 * lib/mcp/server.ts — MCP server: tool registry and JSON-RPC dispatch
 *
 * Replaces @modelcontextprotocol/sdk (ADR-009). Keeps the SDK's registration
 * signature — server.tool(name, description, shape, handler) — so the 30 call
 * sites in index.ts read the same as before.
 *
 * Implements only what crux needs: initialize, notifications/initialized,
 * tools/list, tools/call, ping.
 */

import { parse, toJsonSchema } from './schema.ts';
import type { Infer, Shape } from './schema.ts';
import {
  StdioTransport, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND,
} from './stdio.ts';
import type { JsonRpcMessage, JsonRpcResponse } from './stdio.ts';

/** What a tool handler returns — the MCP content block shape. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type ToolHandler<S extends Shape> = (args: Infer<S>) => ToolResult | Promise<ToolResult>;

interface RegisteredTool {
  name: string;
  description: string;
  shape: Shape;
  handler: (args: never) => ToolResult | Promise<ToolResult>;
}

/**
 * Protocol versions this server understands, newest first. If the client asks
 * for one of these we echo it back; otherwise we answer with our newest and
 * let the client decide whether it can proceed.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export class McpServer {
  private readonly tools = new Map<string, RegisteredTool>();

  // Explicit field, not a parameter property: node's strip-only TypeScript
  // mode rejects those, since they emit runtime code.
  private readonly info: { name: string; version: string };

  constructor(info: { name: string; version: string }) {
    this.info = info;
  }

  tool<S extends Shape>(name: string, description: string, shape: S, handler: ToolHandler<S>): void {
    this.tools.set(name, {
      name, description, shape,
      handler: handler as (args: never) => ToolResult | Promise<ToolResult>,
    });
  }

  async handle(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    const id = msg.id ?? null;
    // A message without an id is a notification: process it, answer nothing.
    const isNotification = msg.id === undefined;

    try {
      switch (msg.method) {
        case 'initialize':
          return this.reply(id, this.initialize(msg.params));

        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;

        case 'ping':
          return this.reply(id, {});

        case 'tools/list':
          return this.reply(id, {
            tools: [...this.tools.values()].map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: toJsonSchema(t.shape),
            })),
          });

        case 'tools/call':
          return await this.callTool(id, msg.params);

        default:
          if (isNotification) return null;
          return this.fail(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
      }
    } catch (e: unknown) {
      if (isNotification) return null;
      return this.fail(id, INTERNAL_ERROR, (e as Error).message);
    }
  }

  /** Wire the server to stdin/stdout and run until stdin closes. */
  async connect(transport: StdioTransport = new StdioTransport()): Promise<void> {
    await transport.start(msg => this.handle(msg));
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private initialize(params: unknown): unknown {
    const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
    const protocolVersion =
      requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];

    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: this.info,
    };
  }

  private async callTool(id: JsonRpcResponse['id'], params: unknown): Promise<JsonRpcResponse> {
    const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: unknown };

    if (!name) return this.fail(id, INVALID_PARAMS, 'tools/call requires a tool name');

    const tool = this.tools.get(name);
    if (!tool) return this.fail(id, INVALID_PARAMS, `Tool not found: ${name}`);

    const parsed = parse(tool.shape, args);
    if (!parsed.ok) {
      return this.fail(id, INVALID_PARAMS, `Invalid arguments for ${name}: ${parsed.errors.join('; ')}`);
    }

    // A throwing handler is a tool failure, not a protocol failure: report it
    // in-band as isError so the client sees the message instead of a transport
    // error. Matches how the tools' own err() helper behaves.
    try {
      const result = await tool.handler(parsed.value as never);
      return this.reply(id, result);
    } catch (e: unknown) {
      return this.reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      });
    }
  }

  private reply(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private fail(id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

export { StdioTransport };
