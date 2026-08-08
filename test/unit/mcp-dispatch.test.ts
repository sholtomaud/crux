/**
 * test/unit/mcp-dispatch.test.ts — JSON-RPC dispatch and stdio framing (ADR-009)
 *
 * Drives the transport through feed() with a fake stdout, so the framing is
 * exercised for real without spawning a process.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { McpServer } from '../../lib/mcp/server.ts';
import { StdioTransport } from '../../lib/mcp/stdio.ts';
import { z } from '../../lib/mcp/schema.ts';
import type { JsonRpcResponse } from '../../lib/mcp/stdio.ts';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'crux', version: '0.1.0' });
  server.tool('echo', 'Echo a slug back', { slug: z.string() },
    ({ slug }) => ({ content: [{ type: 'text', text: slug }] }));
  server.tool('boom', 'Always throws', {}, () => { throw new Error('handler exploded'); });
  return server;
}

/** Collects everything the transport writes to "stdout". */
function fakeStdout(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  const stream = { write: (chunk: string) => { lines.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

async function send(server: McpServer, raw: string): Promise<JsonRpcResponse[]> {
  const { lines, stream } = fakeStdout();
  const transport = new StdioTransport(process.stdin, stream);
  await transport.feed(raw, msg => server.handle(msg));
  return lines.map(l => JSON.parse(l) as JsonRpcResponse);
}

const rpc = (method: string, params?: unknown, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

describe('initialize', () => {
  test('echoes a protocol version it supports', async () => {
    const [res] = await send(makeServer(), rpc('initialize', { protocolVersion: '2024-11-05' }));
    const result = res!.result as { protocolVersion: string; serverInfo: unknown; capabilities: unknown };
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.deepEqual(result.serverInfo, { name: 'crux', version: '0.1.0' });
    assert.deepEqual(result.capabilities, { tools: {} });
  });

  test('falls back to its newest version when the client asks for an unknown one', async () => {
    const [res] = await send(makeServer(), rpc('initialize', { protocolVersion: '1999-01-01' }));
    assert.equal((res!.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
  });
});

describe('tools/list', () => {
  test('advertises each tool with its JSON Schema', async () => {
    const [res] = await send(makeServer(), rpc('tools/list'));
    const { tools } = res!.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };

    assert.deepEqual(tools.map(t => t.name), ['echo', 'boom']);
    assert.deepEqual(tools[0]!.inputSchema, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    });
    // A no-argument tool still advertises an object schema, not null.
    assert.deepEqual(tools[1]!.inputSchema, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
    });
  });
});

describe('tools/call', () => {
  test('runs the handler and returns its content', async () => {
    const [res] = await send(makeServer(), rpc('tools/call', { name: 'echo', arguments: { slug: 'p1' } }));
    assert.deepEqual(res!.result, { content: [{ type: 'text', text: 'p1' }] });
  });

  test('unknown tool name is an invalid-params error', async () => {
    const [res] = await send(makeServer(), rpc('tools/call', { name: 'nope', arguments: {} }));
    assert.equal(res!.error?.code, -32602);
    assert.match(res!.error!.message, /Tool not found: nope/);
  });

  test('invalid arguments are rejected before the handler runs', async () => {
    const [res] = await send(makeServer(), rpc('tools/call', { name: 'echo', arguments: { slug: 42 } }));
    assert.equal(res!.error?.code, -32602);
    assert.match(res!.error!.message, /slug: expected string, got number/);
  });

  test('missing required argument is rejected', async () => {
    const [res] = await send(makeServer(), rpc('tools/call', { name: 'echo', arguments: {} }));
    assert.equal(res!.error?.code, -32602);
    assert.match(res!.error!.message, /slug: required/);
  });

  test('a throwing handler is reported in-band as isError, not as a transport error', async () => {
    const [res] = await send(makeServer(), rpc('tools/call', { name: 'boom' }));
    assert.equal(res!.error, undefined);
    const result = res!.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /handler exploded/);
  });
});

describe('protocol handling', () => {
  test('malformed JSON gets a parse error with a null id', async () => {
    const [res] = await send(makeServer(), 'not json at all\n');
    assert.equal(res!.error?.code, -32700);
    assert.equal(res!.id, null);
  });

  test('a bad line does not poison the lines after it', async () => {
    const responses = await send(makeServer(), '{oops\n' + rpc('tools/call', { name: 'echo', arguments: { slug: 'ok' } }, 7));
    assert.equal(responses.length, 2);
    assert.equal(responses[0]!.error?.code, -32700);
    assert.equal(responses[1]!.id, 7);
    assert.deepEqual(responses[1]!.result, { content: [{ type: 'text', text: 'ok' }] });
  });

  test('unknown method is method-not-found', async () => {
    const [res] = await send(makeServer(), rpc('resources/list'));
    assert.equal(res!.error?.code, -32601);
  });

  test('notifications get no response at all', async () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n';
    assert.deepEqual(await send(makeServer(), raw), []);
  });

  test('an unknown notification is silently ignored rather than answered', async () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatever' }) + '\n';
    assert.deepEqual(await send(makeServer(), raw), []);
  });

  test('ping is answered with an empty result', async () => {
    const [res] = await send(makeServer(), rpc('ping'));
    assert.deepEqual(res!.result, {});
  });

  test('blank lines are skipped', async () => {
    assert.deepEqual(await send(makeServer(), '\n\n  \n'), []);
  });

  test('a message split across chunks is buffered until its newline arrives', async () => {
    const { lines, stream } = fakeStdout();
    const transport = new StdioTransport(process.stdin, stream);
    const server = makeServer();
    const whole = rpc('tools/call', { name: 'echo', arguments: { slug: 'split' } });

    await transport.feed(whole.slice(0, 20), m => server.handle(m));
    assert.deepEqual(lines, [], 'no response before the newline arrives');

    await transport.feed(whole.slice(20), m => server.handle(m));
    assert.equal(lines.length, 1);
    assert.deepEqual((JSON.parse(lines[0]!) as JsonRpcResponse).result,
      { content: [{ type: 'text', text: 'split' }] });
  });

  test('every response is exactly one newline-terminated line', async () => {
    const { lines, stream } = fakeStdout();
    const transport = new StdioTransport(process.stdin, stream);
    const server = makeServer();
    await transport.feed(rpc('tools/list') + rpc('ping', undefined, 2), m => server.handle(m));

    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.endsWith('\n'), true);
      assert.equal(line.trimEnd().includes('\n'), false, 'no embedded newlines — one message per line');
    }
  });
});
