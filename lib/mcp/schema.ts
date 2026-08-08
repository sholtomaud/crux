/**
 * lib/mcp/schema.ts — tool input schemas: JSON Schema out, validation in
 *
 * Covers exactly the subset of the zod API crux's tool registrations use
 * (see ADR-009). It is not a general-purpose validation library: add to it
 * when a tool needs something new, not speculatively.
 *
 * Two jobs:
 *   toJsonSchema(shape) — what tools/list advertises to the client
 *   parse(shape, input) — what tools/call trusts before reaching the DB layer
 */

type JsonSchema = Record<string, unknown>;

type Kind = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';

interface Def {
  kind: Kind;
  description?: string;
  optional?: boolean;
  /** Present (even as undefined) only when .default() was called. */
  hasDefault?: boolean;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  values?: readonly string[];      // enum
  item?: Schema<unknown>;          // array
  shape?: Shape;                   // object
}

export class Schema<T> {
  /** Phantom: carries T so Infer<> can read it. Never assigned at runtime. */
  declare readonly _out: T;

  // Explicit field + assignment, not a parameter property: node's strip-only
  // TypeScript mode rejects parameter properties, since they emit runtime code.
  readonly def: Def;

  constructor(def: Def) {
    this.def = def;
  }

  private extend<U>(patch: Partial<Def>): Schema<U> {
    return new Schema<U>({ ...this.def, ...patch });
  }

  describe(description: string): Schema<T> {
    return this.extend<T>({ description });
  }

  optional(): Schema<T | undefined> {
    return this.extend<T | undefined>({ optional: true });
  }

  /**
   * Input becomes optional; output stays T, because the default is applied
   * during parse. Mirrors zod: the handler never sees undefined.
   */
  default(defaultValue: T): Schema<T> {
    return this.extend<T>({ hasDefault: true, defaultValue });
  }

  /** Numbers: minimum value. Arrays: minimum length. */
  min(min: number): Schema<T> {
    return this.extend<T>({ min });
  }

  /** Numbers: maximum value. Arrays: maximum length. */
  max(max: number): Schema<T> {
    return this.extend<T>({ max });
  }
}

// ── Constructors ───────────────────────────────────────────────────────────────

export const z = {
  string:  (): Schema<string>  => new Schema({ kind: 'string' }),
  number:  (): Schema<number>  => new Schema({ kind: 'number' }),
  boolean: (): Schema<boolean> => new Schema({ kind: 'boolean' }),

  enum: <const V extends readonly string[]>(values: V): Schema<V[number]> =>
    new Schema({ kind: 'enum', values }),

  array: <T>(item: Schema<T>): Schema<T[]> =>
    new Schema({ kind: 'array', item: item as Schema<unknown> }),

  object: <S extends Shape>(shape: S): Schema<Infer<S>> =>
    new Schema({ kind: 'object', shape }),
};

// ── Type inference ─────────────────────────────────────────────────────────────

export type Shape = Record<string, Schema<unknown>>;

type Out<S> = S extends Schema<infer T> ? T : never;

// A key is optional in the handler's argument object only when .optional() was
// used. .default() also makes the *input* optional, but the parsed value is
// always present, so the key stays required in the inferred type.
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Out<S[K]> ? K : never;
}[keyof S];

export type Infer<S extends Shape> =
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Out<S[K]> } &
  { [K in OptionalKeys<S>]?: Out<S[K]> };

// ── JSON Schema emit ───────────────────────────────────────────────────────────

function nodeToJson(schema: Schema<unknown>): JsonSchema {
  const d = schema.def;
  const out: JsonSchema = {};

  switch (d.kind) {
    case 'string':  out.type = 'string';  break;
    case 'boolean': out.type = 'boolean'; break;
    case 'number':
      out.type = 'number';
      if (d.min !== undefined) out.minimum = d.min;
      if (d.max !== undefined) out.maximum = d.max;
      break;
    case 'enum':
      out.type = 'string';
      out.enum = d.values;
      break;
    case 'array':
      out.type  = 'array';
      out.items = nodeToJson(d.item!);
      if (d.min !== undefined) out.minItems = d.min;
      if (d.max !== undefined) out.maxItems = d.max;
      break;
    case 'object':
      // Nested objects carry no $schema — only the top-level tool schema does.
      Object.assign(out, objectSchema(d.shape!));
      break;
  }

  if (d.description !== undefined) out.description = d.description;
  if (d.hasDefault) out.default = d.defaultValue;
  return out;
}

const JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';

function objectSchema(shape: Shape): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, schema] of Object.entries(shape)) {
    properties[key] = nodeToJson(schema);
    // .default() satisfies a required field, so only .optional() relaxes it.
    if (!schema.def.optional && !schema.def.hasDefault) required.push(key);
  }

  const out: JsonSchema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

/**
 * The `inputSchema` a tool advertises in tools/list. Declares the draft-07
 * dialect at the top level, matching what zod-to-json-schema emitted, so the
 * wire format is unchanged for clients that read it.
 */
export function toJsonSchema(shape: Shape): JsonSchema {
  return { $schema: JSON_SCHEMA_DIALECT, ...objectSchema(shape) };
}

// ── Validation ─────────────────────────────────────────────────────────────────

export interface ParseOk<T>   { ok: true;  value: T }
export interface ParseFail    { ok: false; errors: string[] }
export type ParseResult<T> = ParseOk<T> | ParseFail;

function validateNode(schema: Schema<unknown>, value: unknown, path: string, errors: string[]): unknown {
  const d = schema.def;

  switch (d.kind) {
    case 'string':
      if (typeof value !== 'string') { errors.push(`${path}: expected string, got ${typeName(value)}`); return undefined; }
      return value;

    case 'boolean':
      if (typeof value !== 'boolean') { errors.push(`${path}: expected boolean, got ${typeName(value)}`); return undefined; }
      return value;

    case 'number':
      // Number.isFinite rejects NaN and Infinity, neither of which survives a
      // round trip through JSON anyway — but a client can still send them.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}: expected number, got ${typeName(value)}`); return undefined;
      }
      if (d.min !== undefined && value < d.min) { errors.push(`${path}: must be >= ${d.min}, got ${value}`); return undefined; }
      if (d.max !== undefined && value > d.max) { errors.push(`${path}: must be <= ${d.max}, got ${value}`); return undefined; }
      return value;

    case 'enum':
      if (typeof value !== 'string' || !d.values!.includes(value)) {
        errors.push(`${path}: expected one of ${d.values!.join('|')}, got ${JSON.stringify(value)}`); return undefined;
      }
      return value;

    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${path}: expected array, got ${typeName(value)}`); return undefined; }
      if (d.min !== undefined && value.length < d.min) { errors.push(`${path}: expected at least ${d.min} item(s), got ${value.length}`); return undefined; }
      if (d.max !== undefined && value.length > d.max) { errors.push(`${path}: expected at most ${d.max} item(s), got ${value.length}`); return undefined; }
      return value.map((v, i) => validateNode(d.item!, v, `${path}[${i}]`, errors));
    }

    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${typeName(value)}`); return undefined;
      }
      return validateShape(d.shape!, value as Record<string, unknown>, `${path}.`, errors);
    }
  }
}

function validateShape(
  shape: Shape, input: Record<string, unknown>, prefix: string, errors: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(shape)) {
    const raw = input[key];

    if (raw === undefined || raw === null) {
      if (schema.def.hasDefault)     { out[key] = schema.def.defaultValue; continue; }
      if (schema.def.optional)       continue;
      errors.push(`${prefix}${key}: required`);
      continue;
    }

    const parsed = validateNode(schema, raw, `${prefix}${key}`, errors);
    if (parsed !== undefined) out[key] = parsed;
  }

  // Unknown keys are dropped rather than rejected — same as zod's default
  // strip behaviour, so a client sending extra fields still works.
  return out;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Validate a tools/call argument object against a tool's shape. */
export function parse<S extends Shape>(shape: S, input: unknown): ParseResult<Infer<S>> {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [`arguments: expected object, got ${typeName(input)}`] };
  }

  const errors: string[] = [];
  const value = validateShape(shape, input as Record<string, unknown>, '', errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as Infer<S> };
}
