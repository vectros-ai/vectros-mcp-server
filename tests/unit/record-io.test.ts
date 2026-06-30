/**
 * Unit tests for the records-I/O tier (launch data-plane surface, tier 1):
 * record_get, record_create, record_update, record_delete. Mocked SDK client.
 *
 * Focus: the logic that isn't just args-passthrough — typeName-direct create
 * (no schemaId pre-fetch), the RFC-7386 merge-patch update (payload sent
 * as-is for the server to deep-merge; optimistic-concurrency via expectedVersion),
 * payload truncation in get, and the scope-error path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';

import recordGet from '../../src/tools/record_get.js';
import recordCreate from '../../src/tools/record_create.js';
import recordUpdate from '../../src/tools/record_update.js';
import recordDelete from '../../src/tools/record_delete.js';

const log = pino({ level: 'silent' });

function spy() {
  const calls: Array<{ method: string; args: unknown }> = [];
  return { calls, record: (m: string, a: unknown) => calls.push({ method: m, args: a }) };
}
function parsedText(result: { content: Array<{ type: string; text: string }> }): unknown {
  assert.equal(result.content[0]?.type, 'text');
  return JSON.parse(result.content[0]!.text);
}

// ============================================================================
// record_get
// ============================================================================

test('record_get fetches by id and returns the record', async () => {
  const s = spy();
  const client = {
    records: {
      getRecord: async (args: unknown) => {
        s.record('getRecord', args);
        return { id: 'rec_1', typeName: 'task', payload: { title: 'Hi' }, version: 2 };
      },
    },
  } as never;
  const r = await recordGet({ client, log }).handler({ id: 'rec_1' }, {});
  assert.ok(!r.isError);
  assert.deepEqual(s.calls[0].args, { id: 'rec_1' });
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.id, 'rec_1');
  assert.deepEqual(body.payload, { title: 'Hi' });
  assert.equal(body.payloadTruncated, undefined, 'small payload not truncated');
});

test('record_get truncates an oversized payload into a labelled string preview', async () => {
  const big = 'x'.repeat(50_000);
  const client = {
    records: { getRecord: async () => ({ id: 'rec_1', payload: { blob: big } }) },
  } as never;
  const r = await recordGet({ client, log }).handler({ id: 'rec_1' }, {});
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.payloadTruncated, true);
  // The structured `payload` slot is dropped (never an invalid-JSON string);
  // the truncated content lives under `payloadPreview` (mirrors document_get).
  assert.equal(body.payload, undefined, 'structured payload dropped, not replaced by a broken string');
  assert.equal(typeof body.payloadPreview, 'string');
  assert.ok((body.payloadPreview as string).length <= 32_000);
  assert.equal(body.payloadTotalChars, JSON.stringify({ blob: big }).length);
});

test('record_get surfaces SDK errors as isError', async () => {
  const client = {
    records: {
      getRecord: async () => {
        const e = new Error('not found') as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      },
    },
  } as never;
  const r = await recordGet({ client, log }).handler({ id: 'missing' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /404/);
});

// ============================================================================
// record_create
// ============================================================================

test('record_create passes typeName directly (no schemaId pre-fetch)', async () => {
  const s = spy();
  const client = {
    schemas: {
      // Must NOT be called — the server resolves the schema from typeName.
      listSchemas: async (args: unknown) => {
        s.record('listSchemas', args);
        return { data: [], nextCursor: null };
      },
    },
    records: {
      createRecord: async (args: unknown) => {
        s.record('createRecord', args);
        return { id: 'rec_new', typeName: 'task', schemaId: 'sch_task' };
      },
    },
  } as never;
  const r = await recordCreate({ client, log }).handler(
    { type: 'task', fields: { title: 'Do it', status: 'todo' }, externalId: 'x-1' },
    {},
  );
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(s.calls.find((c) => c.method === 'listSchemas'), undefined, 'no schema pre-fetch');
  // The request body nests under `body` (SDK 0.31 un-inlined it when `?upsert` was added).
  const create = (s.calls.find((c) => c.method === 'createRecord')!.args as { body: Record<string, unknown> }).body;
  assert.equal(create.typeName, 'task');
  assert.equal(create.schemaId, undefined, 'no schemaId sent — the server resolves it from typeName');
  assert.deepEqual(create.payload, { title: 'Do it', status: 'todo' }, 'fields → payload');
  assert.equal(create.externalId, 'x-1');
});

test('record_create surfaces an unknown-type error from the SDK', async () => {
  const client = {
    records: {
      createRecord: async () => {
        const e = new Error("No schema found for type 'nonexistent'") as Error & { statusCode: number };
        e.statusCode = 400;
        throw e;
      },
    },
  } as never;
  const r = await recordCreate({ client, log }).handler({ type: 'nonexistent', fields: {} }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /nonexistent|schema/i);
});

test('record_create surfaces a scope error from the SDK (read-only key)', async () => {
  const client = {
    records: {
      createRecord: async () => {
        const e = new Error('Insufficient scope: records:c required') as Error & { statusCode: number };
        e.statusCode = 403;
        throw e;
      },
    },
  } as never;
  const r = await recordCreate({ client, log }).handler({ type: 'task', fields: { title: 'x' } }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /403|scope/i);
});

// ============================================================================
// record_update — RFC-7386 merge-patch + optimistic concurrency
// ============================================================================

test('record_update sends the fields as the merge-patch payload (no read-modify-write)', async () => {
  const s = spy();
  const client = {
    records: {
      // getRecord must NOT be called — PATCH merges server-side.
      getRecord: async (a: unknown) => {
        s.record('getRecord', a);
        return {};
      },
      patchRecord: async (args: unknown) => {
        s.record('patchRecord', args);
        return { id: 'rec_1', version: 5 };
      },
    },
  } as never;
  const r = await recordUpdate({ client, log }).handler(
    { id: 'rec_1', fields: { status: 'done' } },
    {},
  );
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(s.calls.find((c) => c.method === 'getRecord'), undefined, 'no read-modify-write');
  const call = s.calls.find((c) => c.method === 'patchRecord')!.args as Record<string, unknown>;
  assert.equal(call.id, 'rec_1');
  const body = call.body as Record<string, unknown>;
  assert.deepEqual(body.payload, { status: 'done' }, 'fields sent verbatim for the server to deep-merge');
  assert.equal(body.typeName, undefined, 'immutable typeName not sent on a patch');
  assert.equal(body.schemaId, undefined, 'immutable schemaId not sent on a patch');
  assert.equal(body.expectedVersion, undefined, 'no version pin when the caller omits expectedVersion');
});

test('record_update forwards expectedVersion + status; server enforces the conflict (409 → isError)', async () => {
  const s = spy();
  const client = {
    records: {
      patchRecord: async (args: unknown) => {
        s.record('patchRecord', args);
        const e = new Error('VERSION_CONFLICT: record is at version 7') as Error & { statusCode: number };
        e.statusCode = 409;
        throw e;
      },
    },
  } as never;
  const r = await recordUpdate({ client, log }).handler(
    { id: 'rec_1', fields: { x: 1 }, status: 'ARCHIVED', expectedVersion: 5 },
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /409|conflict/i);
  const body = (s.calls[0].args as { body: Record<string, unknown> }).body;
  assert.equal(body.expectedVersion, 5, 'caller version forwarded for server-side optimistic concurrency');
  assert.equal(body.status, 'ARCHIVED', 'status forwarded when provided');
});

// ============================================================================
// record_delete
// ============================================================================

test('record_delete calls deleteRecord and confirms', async () => {
  const s = spy();
  const client = {
    records: {
      deleteRecord: async (args: unknown) => {
        s.record('deleteRecord', args);
      },
    },
  } as never;
  const r = await recordDelete({ client, log }).handler({ id: 'rec_1' }, {});
  assert.ok(!r.isError);
  assert.deepEqual(s.calls[0].args, { id: 'rec_1' });
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.deleted, true);
  assert.equal(body.id, 'rec_1');
});

test('record_delete surfaces a scope error (key lacks records:d)', async () => {
  const client = {
    records: {
      deleteRecord: async () => {
        const e = new Error('Insufficient scope: records:d required') as Error & { statusCode: number };
        e.statusCode = 403;
        throw e;
      },
    },
  } as never;
  const r = await recordDelete({ client, log }).handler({ id: 'rec_1' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /403|scope/i);
});
