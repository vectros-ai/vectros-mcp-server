/**
 * Every array argument of every tool carries a size limit, so an oversized array is refused with one
 * issue before any element is parsed (zod only stops accumulating one issue per failing element for
 * an array schema that has a size check). A new tool cannot add an unbounded array argument without
 * either bounding it or naming it, with the reason, in UNBOUNDED_BY_DESIGN below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import pino from 'pino';

import { ALL_TOOL_FACTORIES } from '../../src/tools/index.js';
import { MAX_CONTENT_TYPES, MAX_OWNERSHIP_SCOPES, MAX_SCOPE_FILTERS } from '../../src/tools/limits.js';

const log = pino({ level: 'silent' });
const fakeClient = {} as never;

// Array arguments deliberately left without a size limit. Empty today: every array argument is
// bounded. Adding an entry here is a decision, not a convenience; bound the array instead.
const UNBOUNDED_BY_DESIGN: ReadonlySet<string> = new Set([]);

type Node = z.ZodTypeAny;

function hasMax(arr: Node): boolean {
  const checks = (arr as unknown as { _zod: { def: { checks?: Array<{ _zod: { def: { check: string } } }> } } })._zod.def.checks ?? [];
  return checks.some((c) => c._zod.def.check === 'max_length' || c._zod.def.check === 'length_equals');
}

// Schema types that cannot contain an array, so the walker has nothing to look into.
const LEAF_TYPES = new Set([
  'string', 'number', 'boolean', 'bigint', 'symbol', 'null', 'undefined', 'void', 'never', 'any', 'unknown',
  'date', 'nan', 'enum', 'literal', 'file', 'template_literal', 'custom',
]);

interface Def {
  type: string;
  innerType?: Node;
  element?: Node;
  valueType?: Node;
  keyType?: Node;
  options?: Node[];
  items?: Node[];
  rest?: Node | null;
  left?: Node;
  right?: Node;
  in?: Node;
  out?: Node;
  getter?: () => Node;
}

/**
 * Walk a schema, reporting `path` for every array that has no size check. A schema type the walker
 * neither descends into nor knows to be a leaf THROWS, so a new tool cannot hide an unbounded array
 * behind a construct this test does not understand.
 */
function unboundedArrays(schema: Node, path: string, out: string[]): void {
  const def = (schema as unknown as { _zod: { def: Def } })._zod.def;
  const into = (child: Node | null | undefined, suffix: string): void => {
    if (child) unboundedArrays(child, `${path}${suffix}`, out);
  };
  switch (def.type) {
    case 'optional': case 'nullable': case 'default': case 'prefault': case 'nonoptional': case 'catch': case 'readonly':
      into(def.innerType, '');
      return;
    case 'array':
      if (!hasMax(schema)) out.push(path);
      into(def.element, '[]');
      return;
    case 'object':
      for (const [k, v] of Object.entries((schema as z.ZodObject).shape)) into(v as Node, `.${k}`);
      return;
    case 'record':
      into(def.valueType, '.*');
      return;
    case 'map':
      into(def.keyType, '.key');
      into(def.valueType, '.value');
      return;
    case 'set':
      into(def.valueType, '{}');
      return;
    case 'union':
      (def.options ?? []).forEach((o, n) => into(o, `|${n}`));
      return;
    case 'tuple':
      (def.items ?? []).forEach((o, n) => into(o, `[${n}]`));
      into(def.rest, '[...]');
      return;
    case 'intersection':
      into(def.left, '&left');
      into(def.right, '&right');
      return;
    case 'pipe':
      into(def.in, '>in');
      into(def.out, '>out');
      return;
    case 'lazy':
      into(def.getter?.(), '');
      return;
    default:
      if (LEAF_TYPES.has(def.type)) return;
      throw new Error(`the array-limit walker does not know schema type '${def.type}' at ${path}: teach it or bound the array another way`);
  }
}

function allUnbounded(): string[] {
  const found: string[] = [];
  for (const factory of Object.values(ALL_TOOL_FACTORIES)) {
    const tool = factory({ client: fakeClient, log });
    for (const [arg, schema] of Object.entries(tool.inputSchema)) unboundedArrays(schema as Node, `${tool.name}.${arg}`, found);
  }
  return found;
}

test('every array argument of every tool has a size limit, or is named as unbounded by design', () => {
  const unexpected = allUnbounded().filter((p) => !UNBOUNDED_BY_DESIGN.has(p));
  assert.deepEqual(unexpected, [], `unbounded array argument(s): ${unexpected.join(', ')}`);
});

test('the unbounded-by-design list names only arrays that are still unbounded', () => {
  const found = new Set(allUnbounded());
  const stale = [...UNBOUNDED_BY_DESIGN].filter((p) => !found.has(p));
  assert.deepEqual(stale, [], `now bounded (or gone), remove from the list: ${stale.join(', ')}`);
});

function shapeOf(toolName: string): z.ZodRawShape {
  return ALL_TOOL_FACTORIES[toolName]({ client: fakeClient, log }).inputSchema as z.ZodRawShape;
}

/** The distinct issue paths of a failed parse (empty when it succeeded), dot-joined. */
function issuePaths(r: { success: boolean; error?: z.ZodError }): string[] {
  return r.success || !r.error ? [] : [...new Set(r.error.issues.map((i) => i.path.map(String).join('.')))];
}

const SCOPES_TOOLS: Array<[string, (scopes: unknown) => Record<string, unknown>]> = [
  ['document_ingest', (scopes) => ({ text: 'body', title: 't', scopes })],
  ['document_update', (scopes) => ({ id: 'd1', scopes })],
  ['folder_create', (scopes) => ({ name: 'f', scopes })],
  ['folder_update', (scopes) => ({ id: 'f1', scopes })],
  ['record_create', (scopes) => ({ typeName: 'note', payload: {}, scopes })],
];

for (const [tool, args] of SCOPES_TOOLS) {
  test(`${tool}: scopes accepts ${MAX_OWNERSHIP_SCOPES} entries and refuses more with one issue`, () => {
    const schema = z.object(shapeOf(tool)).strict();
    const two = schema.safeParse(args(['org:a', 'client:b']));
    const scopesIssues = (r: ReturnType<typeof schema.safeParse>): number =>
      r.success ? 0 : r.error.issues.filter((i) => i.path[0] === 'scopes').length;
    assert.equal(scopesIssues(two), 0, `two scopes must not be refused for scopes: ${JSON.stringify(two.success ? [] : two.error.issues)}`);
    const three = schema.safeParse(args(['org:a', 'client:b', 'group:c']));
    assert.equal(three.success, false);
    assert.equal(scopesIssues(three), 1);
  });
}

test('record_batch_write: an item with more scopes than the API allows is refused', () => {
  const schema = z.object(shapeOf('record_batch_write')).strict();
  const item = (scopes: string[]) => ({ type: 'note', fields: {}, scopes });
  const ok = schema.safeParse({ items: [item(['org:a', 'client:b'])] });
  assert.equal(ok.success, true, JSON.stringify(ok.success ? [] : ok.error.issues));
  const bad = schema.safeParse({ items: [item(['org:a', 'client:b', 'group:c'])] });
  assert.deepEqual(issuePaths(bad), ['items.0.scopes']);
});

test('hybrid_search and rag_ask: scopeFilters accepts the API maximum and refuses more', () => {
  const hs = z.object(shapeOf('hybrid_search')).strict();
  const filters = (n: number) => Array.from({ length: n }, (_, i) => `ns${i}:v`);
  assert.equal(hs.safeParse({ query: 'q', scopeFilters: filters(MAX_SCOPE_FILTERS) }).success, true);
  const over = hs.safeParse({ query: 'q', scopeFilters: filters(MAX_SCOPE_FILTERS + 1) });
  assert.equal(over.success, false);
  assert.deepEqual(issuePaths(over), ['scopeFilters']);
  const ra = z.object(shapeOf('rag_ask')).strict();
  assert.equal(ra.safeParse({ query: 'q', search: { scopeFilters: filters(MAX_SCOPE_FILTERS) } }).success, true);
  const nested = ra.safeParse({ query: 'q', search: { scopeFilters: filters(MAX_SCOPE_FILTERS + 1) } });
  assert.deepEqual(issuePaths(nested), ['search.scopeFilters']);
});

test('an oversized array of failing elements yields exactly one issue, not one per element', () => {
  const schema = z.object(shapeOf('record_create')).strict();
  const huge = Array.from({ length: 300_000 }, () => 42); // every element fails z.string()
  const r = schema.safeParse({ typeName: 'note', payload: {}, scopes: huge });
  assert.equal(r.success, false);
  const scopesIssues = r.success ? [] : r.error.issues.filter((i) => i.path[0] === 'scopes');
  assert.equal(scopesIssues.length, 1);
  assert.equal(scopesIssues[0].code, 'too_big');
});

test('contentTypes accepts both values and refuses a longer list, on hybrid_search and rag_ask.search', () => {
  const hs = z.object(shapeOf('hybrid_search')).strict();
  const longer = Array(MAX_CONTENT_TYPES + 1).fill('records');
  assert.equal(hs.safeParse({ query: 'q', contentTypes: ['documents', 'records'] }).success, true);
  assert.deepEqual(issuePaths(hs.safeParse({ query: 'q', contentTypes: longer })), ['contentTypes']);
  const ra = z.object(shapeOf('rag_ask')).strict();
  assert.equal(ra.safeParse({ query: 'q', search: { contentTypes: ['documents', 'records'] } }).success, true);
  assert.deepEqual(issuePaths(ra.safeParse({ query: 'q', search: { contentTypes: longer } })), ['search.contentTypes']);
});

// ---------------------------------------------------------------------------------------------
// The walker itself: each case shows it CAN fail, so a green registry test means something.
// ---------------------------------------------------------------------------------------------

const unbounded = z.array(z.string());
const bounded = z.array(z.string()).max(3);
const reported = (schema: Node): string[] => {
  const out: string[] = [];
  unboundedArrays(schema, 'x', out);
  return out;
};

const CONTAINERS: Array<[string, (inner: Node) => Node]> = [
  ['object', (a) => z.object({ k: a })],
  ['optional', (a) => a.optional()],
  ['nullable', (a) => a.nullable()],
  ['default', (a) => a.default([] as never)],
  ['readonly', (a) => a.readonly()],
  ['catch', (a) => a.catch([] as never)],
  ['record', (a) => z.record(z.string(), a)],
  ['map', (a) => z.map(z.string(), a)],
  ['set', (a) => z.set(a)],
  ['union', (a) => z.union([z.string(), a])],
  ['tuple', (a) => z.tuple([z.string(), a])],
  ['tuple rest', (a) => z.tuple([z.string()], a)],
  ['intersection', (a) => z.intersection(z.object({ a: z.string() }), z.object({ b: a }))],
  ['pipe', (a) => z.pipe(a, z.array(z.string()).max(1))],
  ['lazy', (a) => z.lazy(() => a)],
  ['array of', (a) => z.array(a).max(2)],
];

for (const [name, wrap] of CONTAINERS) {
  test(`the walker descends into ${name}: an unbounded array inside is reported, a bounded one is not`, () => {
    assert.equal(reported(wrap(unbounded)).length, 1, `${name} hid an unbounded array`);
    assert.deepEqual(reported(wrap(bounded)), [], `${name} reported a bounded array`);
  });
}

test('the walker throws on a schema type it does not know, rather than passing it', () => {
  assert.throws(() => reported(z.promise(unbounded)), /does not know schema type 'promise'/);
  assert.throws(() => reported(z.object({ k: z.string().transform((v) => [v]) })), /does not know schema type 'transform'/);
});
