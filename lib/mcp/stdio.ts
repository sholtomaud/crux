/**
 * lib/mcp/stdio.ts — MCP stdio transport
 *
 * MCP over stdio is newline-delimited JSON-RPC 2.0: one JSON message per line,
 * requests in on stdin, responses out on stdout. Not LSP-style Content-Length
 * framing.
 *
 * ADR-002: stdout is exclusively the JSON-RPC channel. Nothing in this file
 * writes to stdout except send(); diagnostics go to stderr.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Handles one parsed message; returns a response, or null for notifications. */
export type MessageHandler = (msg: JsonRpcMessage) => Promise<JsonRpcResponse | null>;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export class StdioTransport {
  private buffer = '';

  // Explicit fields, not parameter properties: node's strip-only TypeScript
  // mode rejects those, since they emit runtime code.
  private readonly stdin: NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;

  constructor(
    stdin: NodeJS.ReadableStream = process.stdin,
    stdout: NodeJS.WritableStream = process.stdout,
  ) {
    this.stdin  = stdin;
    this.stdout = stdout;
  }

  send(response: JsonRpcResponse): void {
    this.stdout.write(JSON.stringify(response) + '\n');
  }

  /**
   * Feed raw input. Exposed separately from start() so tests can drive the
   * framing directly without spawning a process or touching real stdio.
   */
  async feed(chunk: string, handler: MessageHandler): Promise<void> {
    this.buffer += chunk;

    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Unparseable input has no id to correlate against, so per JSON-RPC
        // the response carries a null id.
        this.send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error: invalid JSON' } });
        continue;
      }

      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        this.send({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid request: expected a JSON-RPC object' } });
        continue;
      }

      const response = await handler(msg);
      if (response) this.send(response);
    }
  }

  /** Read stdin to EOF, dispatching each line. Resolves when stdin closes. */
  start(handler: MessageHandler): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stdin.setEncoding('utf8');
      // Serialised so a slow handler can't interleave responses out of order.
      let queue: Promise<void> = Promise.resolve();

      this.stdin.on('data', (chunk: string) => {
        queue = queue.then(() => this.feed(chunk, handler)).catch(reject);
      });
      this.stdin.on('end', () => { queue.then(resolve, reject); });
      this.stdin.on('error', reject);
    });
  }
}
