/**
 * test/unit/mcp-schema.test.ts — tool input schemas (ADR-009)
 *
 * The JSON Schema half is what clients see in tools/list; the parse half is
 * the last check before a tools/call reaches the DB layer, so the failure
 * cases matter more than the happy path.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { z, toJsonSchema, parse } from '../../lib/mcp/schema.ts';

describe('toJsonSchema', () => {
  test('emits types, descriptions and a required list', () => {
    const json = toJsonSchema({
      slug:  z.string().describe('Task slug'),
      count: z.number(),
      note:  z.string().optional(),
    });

    assert.deepEqual(json, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        slug:  { type: 'string', description: 'Task slug' },
        count: { type: 'number' },
        note:  { type: 'string' },
      },
      required: ['slug', 'count'],
    });
  });

  test('a defaulted field is advertised as optional, carrying its default', () => {
    const json = toJsonSchema({ type: z.enum(['a', 'b']).default('a') }) as {
      properties: { type: Record<string, unknown> };
      required?: string[];
    };

    assert.equal(json.required, undefined);
    assert.deepEqual(json.properties.type, { type: 'string', enum: ['a', 'b'], default: 'a' });
  });

  test('numeric bounds become minimum/maximum, array bounds minItems/maxItems', () => {
    const json = toJsonSchema({
      score: z.number().min(0).max(100),
      files: z.array(z.string()).min(1).max(3),
    }) as { properties: Record<string, Record<string, unknown>> };

    assert.equal(json.properties.score!.minimum, 0);
    assert.equal(json.properties.score!.maximum, 100);
    assert.deepEqual(json.properties.files!.items, { type: 'string' });
    assert.equal(json.properties.files!.minItems, 1);
    assert.equal(json.properties.files!.maxItems, 3);
  });

  test('nested objects nest their own schema', () => {
    const json = toJsonSchema({
      updates: z.array(z.object({ slug: z.string(), note: z.string().optional() })),
    }) as { properties: { updates: { items: Record<string, unknown> } } };

    // Nested objects carry no $schema — only the top-level tool schema does.
    assert.deepEqual(json.properties.updates.items, {
      type: 'object',
      properties: { slug: { type: 'string' }, note: { type: 'string' } },
      required: ['slug'],
    });
  });
});

describe('parse', () => {
  test('accepts a valid payload and returns the typed value', () => {
    const r = parse({ slug: z.string(), score: z.number() }, { slug: 'a', score: 5 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, { slug: 'a', score: 5 });
  });

  test('reports every missing required field, not just the first', () => {
    const r = parse({ a: z.string(), b: z.string(), c: z.string().optional() }, {});
    assert.equal(r.ok, false);
    assert.deepEqual(!r.ok && r.errors, ['a: required', 'b: required']);
  });

  test('rejects a wrong type with the field name and both types', () => {
    const r = parse({ score: z.number() }, { score: '5' });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.errors[0]! : '', /score: expected number, got string/);
  });

  test('rejects a value outside numeric bounds', () => {
    assert.equal(parse({ v: z.number().min(0).max(100) }, { v: 101 }).ok, false);
    assert.equal(parse({ v: z.number().min(0).max(100) }, { v: -1 }).ok, false);
    assert.equal(parse({ v: z.number().min(0).max(100) }, { v: 0 }).ok, true);
  });

  test('rejects a value outside the enum', () => {
    const r = parse({ status: z.enum(['open', 'done']) }, { status: 'nope' });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.errors[0]! : '', /expected one of open\|done/);
  });

  test('rejects NaN and Infinity, which JSON.parse can still produce via literals', () => {
    assert.equal(parse({ v: z.number() }, { v: Number.NaN }).ok, false);
    assert.equal(parse({ v: z.number() }, { v: Number.POSITIVE_INFINITY }).ok, false);
  });

  test('enforces array length bounds and validates each item', () => {
    assert.equal(parse({ f: z.array(z.string()).min(1) }, { f: [] }).ok, false);
    const bad = parse({ f: z.array(z.string()) }, { f: ['a', 2] });
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.errors[0]! : '', /f\[1\]: expected string, got number/);
  });

  test('applies defaults for absent fields, and does not override a supplied value', () => {
    const shape = { type: z.enum(['code_repo', 'article']).default('code_repo') };

    const absent = parse(shape, {});
    assert.deepEqual(absent.ok && absent.value, { type: 'code_repo' });

    const supplied = parse(shape, { type: 'article' });
    assert.deepEqual(supplied.ok && supplied.value, { type: 'article' });
  });

  test('treats explicit null like absent, so a client sending null gets the default', () => {
    const r = parse({ type: z.string().default('x'), note: z.string().optional() }, { type: null, note: null });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, { type: 'x' });
  });

  test('drops unknown keys rather than rejecting them (zod strip behaviour)', () => {
    const r = parse({ slug: z.string() }, { slug: 'a', extra: 'ignored' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, { slug: 'a' });
  });

  test('missing arguments object is treated as empty, so no-arg tools work', () => {
    assert.equal(parse({}, undefined).ok, true);
    assert.equal(parse({ a: z.string().optional() }, null).ok, true);
  });

  test('rejects a non-object arguments payload', () => {
    assert.equal(parse({ a: z.string() }, 'nope').ok, false);
    assert.equal(parse({ a: z.string() }, ['nope']).ok, false);
  });

  test('validates nested object fields with a dotted path', () => {
    const shape = { updates: z.array(z.object({ slug: z.string(), score: z.number().optional() })) };
    const r = parse(shape, { updates: [{ slug: 'a' }, { score: 1 }] });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.errors[0]! : '', /updates\[1\]\.slug: required/);
  });
});
