/**
 * zod → JSON Schema converter unit tests.
 *
 * MCP clients use the JSON Schema we emit to construct tool-call
 * arg payloads. If this converter produces wrong schemas, agents
 * either skip our tools entirely or send malformed args.
 *
 * Coverage: every branch in zod-to-json-schema.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { zodShapeToJsonSchema, zodTypeToJsonSchema } from '../../src/zod-to-json-schema.js';

test('string + number + boolean primitives convert to JSON Schema types', () => {
  assert.deepEqual(zodTypeToJsonSchema(z.string()), { type: 'string' });
  assert.deepEqual(zodTypeToJsonSchema(z.number()), { type: 'number' });
  assert.deepEqual(zodTypeToJsonSchema(z.boolean()), { type: 'boolean' });
});

test('enum becomes string + enum array', () => {
  const out = zodTypeToJsonSchema(z.enum(['A', 'B', 'C']));
  assert.equal(out.type, 'string');
  assert.deepEqual(out.enum, ['A', 'B', 'C']);
});

test('array becomes type:array with nested items', () => {
  const out = zodTypeToJsonSchema(z.array(z.string()));
  assert.equal(out.type, 'array');
  assert.deepEqual(out.items, { type: 'string' });
});

test('descriptions are preserved through .describe()', () => {
  const out = zodTypeToJsonSchema(z.string().describe('A user query'));
  assert.equal(out.description, 'A user query');
  assert.equal(out.type, 'string');
});

test('description is preserved even when wrapped in optional/default/nullable', () => {
  // Description survives unwrap because we capture it from the OUTER
  // (wrapped) schema before unwrapping.
  const out1 = zodTypeToJsonSchema(z.string().describe('opt').optional());
  assert.equal(out1.description, 'opt');
  assert.equal(out1.type, 'string', 'unwrapped optional reveals string');

  const out2 = zodTypeToJsonSchema(z.number().describe('def').default(42));
  assert.equal(out2.description, 'def');
  assert.equal(out2.type, 'number');

  const out3 = zodTypeToJsonSchema(z.boolean().describe('nul').nullable());
  assert.equal(out3.description, 'nul');
  assert.equal(out3.type, 'boolean');
});

test('shape converts to type:object with properties + required list', () => {
  const shape = {
    name: z.string().describe('Display name'),
    age: z.number().optional(),
    active: z.boolean(),
  };
  const out = zodShapeToJsonSchema(shape);
  assert.equal(out.type, 'object');
  const props = out.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.name.type, 'string');
  assert.equal(props.name.description, 'Display name');
  assert.equal(props.age.type, 'number');
  assert.equal(props.active.type, 'boolean');
  assert.deepEqual(out.required, ['name', 'active'], 'optional fields excluded from required');
});

test('all-optional shape omits the required array entirely', () => {
  const out = zodShapeToJsonSchema({
    a: z.string().optional(),
    b: z.number().optional(),
  });
  assert.equal(out.required, undefined, 'no required list when none required');
});

test('nested object shape converts recursively', () => {
  const out = zodTypeToJsonSchema(
    z.object({
      inner: z.object({
        field: z.string(),
      }),
    }),
  );
  assert.equal(out.type, 'object');
  const props = out.properties as Record<string, Record<string, unknown>>;
  const innerProps = props.inner.properties as Record<string, Record<string, unknown>>;
  assert.equal(innerProps.field.type, 'string');
});

test('z.record converts to type:object with additionalProperties (not an empty fragment)', () => {
  // The record-payload tool params (record_create/record_update `fields`, etc.)
  // are z.record — they must advertise a real object shape to MCP clients.
  const out = zodTypeToJsonSchema(z.record(z.string(), z.unknown()).describe('a payload map'));
  assert.equal(out.type, 'object');
  assert.equal(out.description, 'a payload map');
  assert.deepEqual(out.additionalProperties, {}, 'unknown value type → open additionalProperties');

  // The single-arg form (value-only) is also handled.
  const typed = zodTypeToJsonSchema(z.record(z.string()));
  assert.equal(typed.type, 'object');
  assert.deepEqual(typed.additionalProperties, { type: 'string' });
});

test('unknown zod type falls back to {} (description preserved)', () => {
  // Use z.any() as the unknown-shape stand-in.
  const out = zodTypeToJsonSchema(z.any().describe('fallback'));
  assert.equal(out.description, 'fallback');
  // No `type` field — MCP SDK is tolerant.
  assert.equal(out.type, undefined);
});
