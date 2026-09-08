/**
 * Tool input-schema validation tests. Each tool's zod schema must
 * accept its documented happy-path args and reject obvious bad args.
 * The handler bodies themselves are exercised by the integration +
 * smoke tests against a real or mocked SDK.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import pino from 'pino';

import hybridSearch from '../../src/tools/hybrid_search.js';
import recordQuery from '../../src/tools/record_query.js';
import ragAsk from '../../src/tools/rag_ask.js';
import documentAsk from '../../src/tools/document_ask.js';
import listSchemas from '../../src/tools/list_schemas.js';
import documentGet from '../../src/tools/document_get.js';
import documentQuery from '../../src/tools/document_query.js';
import documentUpdate from '../../src/tools/document_update.js';
import documentDelete from '../../src/tools/document_delete.js';
import folderQuery from '../../src/tools/folder_query.js';
import folderCreate from '../../src/tools/folder_create.js';
import folderUpdate from '../../src/tools/folder_update.js';
import folderDelete from '../../src/tools/folder_delete.js';
import currentIdentity from '../../src/tools/current_identity.js';
import documentIngest from '../../src/tools/document_ingest.js';
import recordCreate from '../../src/tools/record_create.js';
import recordGet from '../../src/tools/record_get.js';
import recordBatchGet from '../../src/tools/record_batch_get.js';
import recordBatchWrite from '../../src/tools/record_batch_write.js';
import recordUpdate from '../../src/tools/record_update.js';
import recordDelete from '../../src/tools/record_delete.js';
import lookupPrincipal from '../../src/tools/lookup_principal.js';
import versionHistory from '../../src/tools/version_history.js';
import { zodShapeToJsonSchema } from '../../src/zod-to-json-schema.js';

const log = pino({ level: 'silent' });

// Minimal fake SDK client — the schema tests don't call it.
const fakeClient = {} as never;

const tools = {
  hybrid_search: hybridSearch({ client: fakeClient, log }),
  record_query: recordQuery({ client: fakeClient, log }),
  rag_ask: ragAsk({ client: fakeClient, log }),
  document_ask: documentAsk({ client: fakeClient, log }),
  list_schemas: listSchemas({ client: fakeClient, log }),
  document_get: documentGet({ client: fakeClient, log }),
  document_query: documentQuery({ client: fakeClient, log }),
  document_update: documentUpdate({ client: fakeClient, log }),
  document_delete: documentDelete({ client: fakeClient, log }),
  folder_query: folderQuery({ client: fakeClient, log }),
  folder_create: folderCreate({ client: fakeClient, log }),
  folder_update: folderUpdate({ client: fakeClient, log }),
  folder_delete: folderDelete({ client: fakeClient, log }),
  current_identity: currentIdentity({ client: fakeClient, log }),
  document_ingest: documentIngest({ client: fakeClient, log }),
  record_create: recordCreate({ client: fakeClient, log }),
  record_get: recordGet({ client: fakeClient, log }),
  record_batch_get: recordBatchGet({ client: fakeClient, log }),
  record_batch_write: recordBatchWrite({ client: fakeClient, log }),
  record_update: recordUpdate({ client: fakeClient, log }),
  record_delete: recordDelete({ client: fakeClient, log }),
  lookup_principal: lookupPrincipal({ client: fakeClient, log }),
  version_history: versionHistory({ client: fakeClient, log }),
};

function validate(tool: keyof typeof tools, args: unknown) {
  return z.object(tools[tool].inputSchema).safeParse(args);
}

test('hybrid_search accepts minimal args', () => {
  const r = validate('hybrid_search', { query: 'anxiety treatment' });
  assert.ok(r.success);
});

test('hybrid_search accepts full args', () => {
  const r = validate('hybrid_search', {
    query: 'q',
    mode: 'HYBRID',
    limit: 5,
    offset: 10,
    folderId: 'fld_1',
  });
  assert.ok(r.success);
});

test('hybrid_search rejects empty query', () => {
  const r = validate('hybrid_search', { query: '' });
  assert.ok(!r.success);
});

test('hybrid_search accepts limit up to the API max (50) + offset for pagination', () => {
  assert.ok(validate('hybrid_search', { query: 'q', limit: 50 }).success, 'limit:50 (the API max) is allowed');
  assert.ok(validate('hybrid_search', { query: 'q', limit: 25, offset: 50 }).success);
});

test('hybrid_search rejects limit > 50 (the API max) and offset > 200', () => {
  assert.ok(!validate('hybrid_search', { query: 'q', limit: 51 }).success, 'limit:51 exceeds the search API max');
  assert.ok(!validate('hybrid_search', { query: 'q', offset: 201 }).success, 'offset:201 exceeds the API max');
});

test('hybrid_search rejects bad mode', () => {
  const r = validate('hybrid_search', { query: 'q', mode: 'FUZZY' });
  assert.ok(!r.success);
});

test('record_query accepts list mode', () => {
  const r = validate('record_query', { type: 'patient', userId: 'usr_1' });
  assert.ok(r.success);
});

test('record_query accepts lookup mode', () => {
  const r = validate('record_query', { type: 'patient', field: 'externalId', value: 'p-001' });
  assert.ok(r.success);
});

test('record_query no longer requires type at the SCHEMA level (mode decides)', () => {
  // `type` became optional in 0.17.0 because list mode can now select by `folderId` or
  // `recent` instead. The requirement did not disappear — it moved into the handler,
  // where it depends on the mode (see the handler tests: a lookup still demands `type`,
  // and a list with no mode selector at all is rejected). Asserting it here would pin the
  // requirement to the wrong layer.
  assert.ok(validate('record_query', { folderId: 'fld_1' }).success, 'list by folder needs no type');
  assert.ok(validate('record_query', { recent: true }).success, 'the recent feed needs no type');
  assert.ok(
    !validate('record_query', { type: '' }).success,
    'an EMPTY type is still rejected — optional means absent, not blank',
  );
});

test('record_query accepts folderId + type together (one type within one folder)', () => {
  assert.ok(validate('record_query', { type: 'task', folderId: 'fld_1' }).success);
});

test('record_query rejects a non-boolean recent', () => {
  assert.ok(!validate('record_query', { recent: 'true' }).success, 'recent is a boolean on the tool surface');
});

test('record_query accepts limit up to the API max (100) + a startFrom cursor', () => {
  assert.ok(validate('record_query', { type: 'patient', limit: 100 }).success, 'limit:100 (the API max) is allowed');
  assert.ok(validate('record_query', { type: 'patient', startFrom: 'cur_1' }).success, 'startFrom cursor accepted');
});

test('record_query rejects limit > 100 (the API max)', () => {
  const r = validate('record_query', { type: 'patient', limit: 101 });
  assert.ok(!r.success);
});

test('record_query accepts a composite lookup (values array) and sortFrom/sortTo', () => {
  const r = validate('record_query', {
    type: 'ticket',
    field: 'status,area',
    values: ['open', 'billing'],
    sortFrom: '1700000000000',
    sortTo: '1800000000000',
  });
  assert.ok(r.success);
});

test('record_query rejects an empty or oversized values array', () => {
  assert.ok(!validate('record_query', { type: 'ticket', field: 'status,area', values: [] }).success);
  assert.ok(
    !validate('record_query', { type: 'ticket', field: 'a,b,c', values: ['1', '2', '3', '4'] }).success,
    'a composite lookup names at most 3 fields',
  );
});

test('rag_ask accepts minimal args', () => {
  const r = validate('rag_ask', { query: 'What treatments has the patient tried?' });
  assert.ok(r.success);
});

test('rag_ask accepts full args', () => {
  const r = validate('rag_ask', {
    query: 'q',
    model: 'claude-sonnet-5',
    search: { mode: 'HYBRID', limit: 5 },
    maxTokens: 1024,
  });
  assert.ok(r.success);
});

test('rag_ask accepts search.limit up to the API max (50)', () => {
  const r = validate('rag_ask', { query: 'q', search: { limit: 50 } });
  assert.ok(r.success, 'corpus limit 50 (the RAG search API max) is allowed');
});

test('rag_ask rejects search.limit > 50 (the API max)', () => {
  const r = validate('rag_ask', { query: 'q', search: { limit: 51 } });
  assert.ok(!r.success);
});

test('document_ask accepts minimal args', () => {
  const r = validate('document_ask', { documentId: 'doc_1', prompt: 'Summarize this.' });
  assert.ok(r.success);
});

test('document_ask rejects missing documentId', () => {
  const r = validate('document_ask', { prompt: 'q' });
  assert.ok(!r.success);
});

test('document_ask rejects empty prompt', () => {
  const r = validate('document_ask', { documentId: 'doc_1', prompt: '' });
  assert.ok(!r.success);
});

test('list_schemas accepts empty args (default = all visible)', () => {
  const r = validate('list_schemas', {});
  assert.ok(r.success);
});

test('list_schemas accepts userId filter', () => {
  const r = validate('list_schemas', { userId: 'usr_1' });
  assert.ok(r.success);
});

test('list_schemas accepts scope filter', () => {
  const r = validate('list_schemas', { scope: 'org:org_1' });
  assert.ok(r.success);
});

test('list_schemas accepts both userId + scope', () => {
  const r = validate('list_schemas', { userId: 'usr_1', scope: 'org:org_1' });
  assert.ok(r.success);
});

test('document_get accepts minimal args (metadata only)', () => {
  const r = validate('document_get', { documentId: 'doc_1' });
  assert.ok(r.success);
});

test('document_get accepts includeText flag', () => {
  const r = validate('document_get', { documentId: 'doc_1', includeText: true });
  assert.ok(r.success);
});

test('document_get accepts the externalId + type selector (schema level)', () => {
  // documentId and externalId are both optional at the schema level (either/or); the
  // handler enforces that exactly one selector is supplied (see tools-handlers tests).
  const r = validate('document_get', { externalId: 'ref-mr-workflow', type: 'reference' });
  assert.ok(r.success);
});

test('document_get rejects non-boolean includeText', () => {
  const r = validate('document_get', { documentId: 'doc_1', includeText: 'yes' });
  assert.ok(!r.success);
});

test('current_identity accepts empty args (no args expected)', () => {
  const r = validate('current_identity', {});
  assert.ok(r.success);
});

test('document_ingest accepts text mode', () => {
  const r = validate('document_ingest', { title: 'My doc', text: 'body' });
  assert.ok(r.success);
});

test('document_ingest accepts text mode with full options (typed: payload + schemaId + externalId)', () => {
  const r = validate('document_ingest', {
    title: 'My doc',
    text: 'body',
    indexMode: 'SEMANTIC',
    storeText: false,
    folderId: 'fld_1',
    payload: { source: 'crawl' },
    schemaId: 'sch_1',
    externalId: 'ext-1',
    userId: 'usr_1',
    scopes: ['org:org_1'],
  });
  assert.ok(r.success);
});

test('document_ingest accepts indexMode NONE (store-only)', () => {
  const r = validate('document_ingest', { title: 'X', text: 'body', indexMode: 'NONE' });
  assert.ok(r.success);
});

test('document_ingest accepts file mode', () => {
  const r = validate('document_ingest', { title: 'X', filePath: '/tmp/foo.pdf' });
  assert.ok(r.success);
});

test('document_ingest accepts file mode with explicit fileType', () => {
  const r = validate('document_ingest', {
    title: 'X',
    filePath: '/tmp/foo.bin',
    fileType: 'application/x-custom',
  });
  assert.ok(r.success);
});

test('document_ingest rejects missing title', () => {
  const r = validate('document_ingest', { text: 'body' });
  assert.ok(!r.success);
});

test('document_ingest rejects bad indexMode', () => {
  const r = validate('document_ingest', { title: 'X', text: 'body', indexMode: 'KEYWORD' });
  assert.ok(!r.success, 'KEYWORD is not a valid indexMode (only HYBRID/SEMANTIC/TEXT/NONE)');
});

test('document_ingest rejects empty text', () => {
  const r = validate('document_ingest', { title: 'X', text: '' });
  assert.ok(!r.success);
});

test('hybrid_search accepts the enrichment surface', () => {
  const r = validate('hybrid_search', {
    query: 'q',
    contentTypes: ['records'],
    typeName: 'patient',
    filters: { status: 'open' },
    rootFolderId: 'fld_root',
    minSimilarity: 0.5,
    uniqueDocuments: true,
    createdAfter: '2026-01-01T00:00:00Z',
  });
  assert.ok(r.success);
});

test('hybrid_search rejects a bad contentTypes enum value', () => {
  const r = validate('hybrid_search', { query: 'q', contentTypes: ['folders'] });
  assert.ok(!r.success, 'only "documents"/"records" are valid content types');
});

test('hybrid_search rejects minSimilarity out of [0,1]', () => {
  const r = validate('hybrid_search', { query: 'q', minSimilarity: 2 });
  assert.ok(!r.success);
});

// document_query ----------------------------------------------------------
test('document_query accepts list mode (no field)', () => {
  const r = validate('document_query', { folderId: 'fld_1', limit: 5 });
  assert.ok(r.success);
});

test('document_query accepts equality-lookup mode', () => {
  const r = validate('document_query', { type: 'invoice', field: 'mrn', value: 'MRN-1' });
  assert.ok(r.success);
});

test('document_query accepts limit up to the API max (100) + a startFrom cursor', () => {
  assert.ok(validate('document_query', { limit: 100 }).success, 'limit:100 (the API max) is allowed');
  assert.ok(validate('document_query', { folderId: 'fld_1', startFrom: 'cur_1' }).success, 'startFrom cursor accepted');
});

test('document_query rejects limit > 100 (the API max)', () => {
  const r = validate('document_query', { limit: 101 });
  assert.ok(!r.success);
});

// document_update ---------------------------------------------------------
test('document_update accepts a patch', () => {
  const r = validate('document_update', { documentId: 'doc_1', fields: { a: 1 }, expectedVersion: 3 });
  assert.ok(r.success);
});

test('document_update accepts the externalId + type selector (schema level)', () => {
  const r = validate('document_update', { externalId: 'ref-mr-workflow', type: 'reference', fields: { a: 1 } });
  assert.ok(r.success);
});

test('document_update rejects non-integer expectedVersion', () => {
  const r = validate('document_update', { documentId: 'doc_1', expectedVersion: 1.5 });
  assert.ok(!r.success);
});

test('document_update accepts status ACTIVE / ARCHIVED (archive + restore)', () => {
  assert.ok(validate('document_update', { documentId: 'doc_1', status: 'ARCHIVED' }).success);
  assert.ok(validate('document_update', { documentId: 'doc_1', status: 'ACTIVE' }).success);
});

test('document_update rejects a status outside the enum (wrong value or casing)', () => {
  assert.ok(!validate('document_update', { documentId: 'doc_1', status: 'DELETED' }).success);
  assert.ok(!validate('document_update', { documentId: 'doc_1', status: 'archived' }).success);
});

// document_delete ---------------------------------------------------------
test('document_delete accepts a documentId', () => {
  const r = validate('document_delete', { documentId: 'doc_1' });
  assert.ok(r.success);
});

test('document_delete rejects empty documentId', () => {
  const r = validate('document_delete', { documentId: '' });
  assert.ok(!r.success);
});

// folder_query ------------------------------------------------------------
test('folder_query accepts get mode (id) and list mode (parentId)', () => {
  assert.ok(validate('folder_query', { id: 'fld_1' }).success);
  assert.ok(validate('folder_query', { parentId: 'fld_root', limit: 20 }).success);
});

test('folder_query accepts limit up to the API max (100); rejects above it', () => {
  assert.ok(validate('folder_query', { parentId: 'root', limit: 100 }).success, 'limit:100 (the API max) is allowed');
  assert.ok(!validate('folder_query', { limit: 101 }).success);
});

// folder_create -----------------------------------------------------------
test('folder_create accepts name + options', () => {
  const r = validate('folder_create', { name: 'Reports', description: 'Q4', parentId: 'root', slug: 'reports' });
  assert.ok(r.success);
});

test('folder_create rejects missing name', () => {
  const r = validate('folder_create', { description: 'no name' });
  assert.ok(!r.success);
});

test('folder_create rejects empty name', () => {
  const r = validate('folder_create', { name: '' });
  assert.ok(!r.success);
});

// folder_update -----------------------------------------------------------
test('folder_update accepts a rename', () => {
  const r = validate('folder_update', { id: 'fld_1', name: 'Renamed' });
  assert.ok(r.success);
});

test('folder_update rejects empty id', () => {
  const r = validate('folder_update', { id: '', name: 'X' });
  assert.ok(!r.success);
});

// folder_delete -----------------------------------------------------------
test('folder_delete accepts an id', () => {
  const r = validate('folder_delete', { id: 'fld_1' });
  assert.ok(r.success);
});

test('folder_delete rejects empty id', () => {
  const r = validate('folder_delete', { id: '' });
  assert.ok(!r.success);
});

// record_batch_get ----------------------------------------------------------
test('record_batch_get accepts 1 to the API max (100) ids', () => {
  assert.ok(validate('record_batch_get', { ids: ['rec_1'] }).success);
  assert.ok(validate('record_batch_get', { ids: Array.from({ length: 100 }, (_, i) => `rec_${i}`) }).success, 'limit:100 (the API max) is allowed');
});

test('record_batch_get rejects an empty ids array or more than 100', () => {
  assert.ok(!validate('record_batch_get', { ids: [] }).success, 'empty array rejected — nothing to fetch');
  assert.ok(!validate('record_batch_get', { ids: Array.from({ length: 101 }, (_, i) => `rec_${i}`) }).success, '101 exceeds the API max');
});

test('record_batch_get rejects missing ids', () => {
  assert.ok(!validate('record_batch_get', {}).success);
});

// record_create -----------------------------------------------------------
test('record_create accepts type + fields, with externalId + indexMode (incl NONE)', () => {
  assert.ok(validate('record_create', { type: 'task', fields: { a: 1 } }).success);
  assert.ok(validate('record_create', { type: 'task', fields: { a: 1 }, externalId: 'e1', indexMode: 'NONE' }).success);
});

test('record_create rejects missing type / bad indexMode', () => {
  assert.ok(!validate('record_create', { fields: { a: 1 } }).success);
  assert.ok(!validate('record_create', { type: 'task', fields: { a: 1 }, indexMode: 'KEYWORD' }).success);
});

// lookup_principal --------------------------------------------------------
test('lookup_principal accepts resolve mode (externalId) and lookup mode (type+field+value)', () => {
  assert.ok(validate('lookup_principal', { kind: 'client', externalId: 'cli_1' }).success);
  assert.ok(validate('lookup_principal', { kind: 'user', type: 'person_v1', field: 'email', value: 'lookup-val', order: 'desc' }).success);
});

test('lookup_principal accepts limit up to the API max (100) + a startFrom cursor', () => {
  assert.ok(validate('lookup_principal', { kind: 'user', externalId: 'x', limit: 100 }).success, 'limit:100 (the API max) is allowed');
  assert.ok(validate('lookup_principal', { kind: 'user', type: 't', field: 'f', value: 'v', startFrom: 'cur_1' }).success);
});

test('lookup_principal rejects a bad order / limit > 100 (kind is a free namespace string)', () => {
  // kind generalized from a closed enum to 'user' or any namespace, so 'team' validates.
  assert.ok(validate('lookup_principal', { kind: 'team', externalId: 'x' }).success);
  assert.ok(!validate('lookup_principal', { kind: 'user', type: 't', field: 'f', value: 'v', order: 'down' }).success);
  assert.ok(!validate('lookup_principal', { kind: 'user', externalId: 'x', limit: 101 }).success);
});

test('lookup_principal rejects missing kind', () => {
  const r = validate('lookup_principal', { externalId: 'x' });
  assert.ok(!r.success, 'kind is required');
});

test('lookup_principal accepts contextId (schema-level: entity-vs-user rejection is a handler check, not the schema)', () => {
  assert.ok(validate('lookup_principal', { kind: 'team', externalId: 'x', contextId: 'ctx_1' }).success);
});

// version_history ---------------------------------------------------------
test('version_history accepts record + document resourceType', () => {
  assert.ok(validate('version_history', { resourceType: 'record', id: 'r1' }).success);
  assert.ok(validate('version_history', { resourceType: 'document', id: 'd1', startFrom: 'cur' }).success);
});

test('version_history rejects a bad resourceType / empty id', () => {
  assert.ok(!validate('version_history', { resourceType: 'folder', id: 'f1' }).success);
  assert.ok(!validate('version_history', { resourceType: 'record', id: '' }).success);
});

test('every tool has the expected MCP-required fields', () => {
  for (const t of Object.values(tools)) {
    assert.ok(t.name, 'name');
    assert.ok(t.title, 'title');
    assert.ok(t.description && t.description.length > 20, 'description (substantive)');
    assert.ok(t.inputSchema, 'inputSchema');
    assert.ok(typeof t.handler === 'function', 'handler');
  }
});

// record_batch_write --------------------------------------------------------
const batchItem = (n: number) => ({ type: 'task', fields: { title: `t${n}` } });

test('record_batch_write accepts 1 to the API max (50) items', () => {
  assert.ok(validate('record_batch_write', { items: [batchItem(0)] }).success);
  assert.ok(
    validate('record_batch_write', { items: Array.from({ length: 50 }, (_, i) => batchItem(i)) }).success,
    '50 items (the API max, identical for both atomicity modes) is allowed',
  );
});

test('record_batch_write rejects an empty items array or more than 50', () => {
  assert.ok(!validate('record_batch_write', { items: [] }).success, 'empty array rejected — nothing to write');
  assert.ok(
    !validate('record_batch_write', { items: Array.from({ length: 51 }, (_, i) => batchItem(i)) }).success,
    '51 exceeds the API max',
  );
});

test('record_batch_write validates each ITEM, not just the array', () => {
  // A per-item shape error must be caught here rather than reaching the API as a
  // 400 the agent has to decode.
  assert.ok(!validate('record_batch_write', { items: [{ fields: {} }] }).success, 'item without `type` rejected');
  assert.ok(!validate('record_batch_write', { items: [{ type: 'task' }] }).success, 'item without `fields` rejected');
  assert.ok(!validate('record_batch_write', { items: [{ type: '', fields: {} }] }).success, 'empty `type` rejected');
  assert.ok(
    !validate('record_batch_write', { items: [{ type: 'task', fields: {}, indexMode: 'SOMETHING' }] }).success,
    'a bad indexMode on one item rejects the batch',
  );
});

test('record_batch_write accepts the optional batch-level knobs and rejects a bad atomicity', () => {
  assert.ok(
    validate('record_batch_write', {
      items: [batchItem(0)],
      atomicity: 'all_or_nothing',
      upsert: true,
      allowClear: true,
    }).success,
  );
  assert.ok(validate('record_batch_write', { items: [batchItem(0)], atomicity: 'best_effort' }).success);
  assert.ok(
    !validate('record_batch_write', { items: [batchItem(0)], atomicity: 'ALL_OR_NOTHING' }).success,
    'the API rejects any value that is not one of the two rather than defaulting — so must the schema, ' +
      'or a typo silently downgrades a transactional batch',
  );
});

test('record_batch_write requires items', () => {
  assert.ok(!validate('record_batch_write', {}).success);
});

// ---------------------------------------------------------------------------
// Description invariants.
//
// A tool description is not documentation a human skims — it is the input the
// agent reasons from when selecting a tool and filling its args, and nothing
// else in the suite reads it. Where a description states a BEHAVIOURAL claim,
// pin it to the same invariant the behaviour is tested for, so the two cannot
// drift apart silently.
// ---------------------------------------------------------------------------

test('record_batch_write description states the item cap its schema actually enforces', () => {
  // The stated number and the enforced number are two different artifacts; an
  // agent that trusts a stale description builds a batch that is rejected locally.
  assert.match(tools.record_batch_write.description, /\b50\b/);
  assert.ok(
    validate('record_batch_write', { items: Array.from({ length: 50 }, (_, i) => batchItem(i)) }).success,
  );
  assert.ok(
    !validate('record_batch_write', { items: Array.from({ length: 51 }, (_, i) => batchItem(i)) }).success,
  );
});

test('record_batch_write description warns that a fully-failed batch is not an error result', () => {
  // The endpoint returns 200 whenever the batch was PROCESSED. This is the single
  // most likely thing for an agent to get wrong, and the handler test
  // ('reports a wholly-failed batch as a SUCCESSFUL call') pins the matching behaviour.
  assert.match(tools.record_batch_write.description, /results/);
  assert.match(tools.record_batch_write.description, /every item failed/i);
});

test('record_batch_write description names the two 0.43.0-new per-item statuses', () => {
  // `forbidden` and `not_committed` were previously inexpressible, and they call for
  // DIFFERENT remedies (fix the credential vs resubmit the batch) — an agent that
  // does not know them treats both as a payload problem.
  assert.match(tools.record_batch_write.description, /forbidden/);
  assert.match(tools.record_batch_write.description, /not_committed/);
});

test('folder_delete description states the emptiness precondition, including records', () => {
  // API 0.43.0 widened the refusal: records now block a folder delete alongside
  // documents and sub-folders. Being non-empty is the most common way this call
  // fails, and the description previously named only protected folders.
  const d = tools.folder_delete.description;
  assert.match(d, /empty/i);
  assert.match(d, /records/i, 'records must be named — 0.43.0 made them block the delete');
  assert.match(d, /sub-folders|subfolders/i);
});

test('hybrid_search and rag_ask describe scopeFilters as mutually exclusive with scope', () => {
  // The pair is rejected together both locally (handler) and server-side. An agent
  // that reads only `scope`'s description would never discover the multi-dimension
  // form; one that sets both gets a refusal it can act on.
  const hs = tools.hybrid_search.inputSchema as Record<string, z.ZodTypeAny>;
  assert.match(hs.scope!.description ?? '', /mutually exclusive/i);
  assert.match(hs.scopeFilters!.description ?? '', /mutually exclusive/i);

  // rag_ask nests both under `search`, so reach into the object's shape rather
  // than asserting on the wrapper's own description.
  const ra = tools.rag_ask.inputSchema as Record<string, z.ZodTypeAny>;
  const searchShape = (ra.search as z.ZodOptional<z.ZodObject<z.ZodRawShape>>).unwrap().shape;
  assert.ok(searchShape.scopeFilters, 'rag_ask.search must expose scopeFilters');
  assert.match(searchShape.scope!.description ?? '', /mutually exclusive/i);
  assert.match(searchShape.scopeFilters!.description ?? '', /mutually exclusive/i);

  assert.match(tools.hybrid_search.description, /scopeFilters/);
  assert.match(tools.rag_ask.description, /scopeFilters/);
});

test('record_batch_write publishes the ITEM shape in its JSON Schema, not a bare array', () => {
  // record_batch_write is the first tool whose input nests objects inside an array.
  // The JSON Schema is literally what the agent reads to construct a call, so an
  // `items: {}` fallback would leave it guessing every per-item field name — the tool
  // would look callable and be unusable. Pin the recursion.
  const js = zodShapeToJsonSchema(tools.record_batch_write.inputSchema) as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const itemsProp = js.properties.items as { type: string; items: Record<string, unknown> };
  assert.equal(itemsProp.type, 'array');
  const item = itemsProp.items as { type: string; properties: Record<string, unknown>; required?: string[] };
  assert.equal(item.type, 'object');
  assert.ok(item.properties.type, 'the item schema must name `type`');
  assert.ok(item.properties.fields, 'the item schema must name `fields`');
  assert.ok(item.properties.externalId, 'the item schema must name the optional `externalId`');
  assert.deepEqual([...(item.required ?? [])].sort(), ['fields', 'type']);
  assert.deepEqual(js.required, ['items'], 'only `items` is required at the top level');
});

test('record_batch_write REJECTS an unknown per-item key rather than silently dropping it', () => {
  // The API's record shape carries fields this tool does not map (expiresAt is a TTL,
  // plus schemaId/expectedVersion). Stripping them silently would report `created` for
  // 50 records that never expire. The server strict-checks the top level; nested objects
  // need their own strictness.
  assert.ok(
    !validate('record_batch_write', {
      items: [{ type: 'task', fields: { a: 1 }, expiresAt: '2027-01-01T00:00:00Z' }],
    }).success,
    'an unmapped `expiresAt` must be rejected, not dropped',
  );
  assert.ok(
    !validate('record_batch_write', { items: [{ type: 'task', fields: {}, schemaId: 'sch_1' }] }).success,
  );
  assert.ok(
    validate('record_batch_write', { items: [{ type: 'task', fields: {}, folderId: 'fld_1' }] }).success,
    'a key the tool DOES map still passes',
  );
});

test('scopeFilters rejects an empty array on both tools (the API 400s on it)', () => {
  assert.ok(!validate('hybrid_search', { query: 'q', scopeFilters: [] }).success);
  assert.ok(!validate('rag_ask', { query: 'q', search: { scopeFilters: [] } }).success);
});

test('hybrid_search states the ARCHIVED exclusion for RECORDS as well as documents', () => {
  // Records have refused to index while archived since API 0.35; the description said
  // "documents" only, which read as an asymmetry implying archived records still match.
  const d = tools.hybrid_search.description;
  assert.match(d, /ARCHIVED/);
  assert.match(d, /records/i, 'records must be named, not just documents');
});

test('hybrid_search warns that a pre-enforcement archived item can still be returned', () => {
  // API 0.43.0 fixed the write paths but explicitly does NOT sweep existing
  // archived-but-still-searchable items: they stay that way until written to again.
  // "never appear in results" would therefore be a false absolute.
  const d = tools.hybrid_search.description;
  assert.doesNotMatch(d, /ARCHIVED \(soft-retracted\) documents never appear/);
  assert.match(d, /re-send status ARCHIVED|re-assert the retraction/i, 'the repair path must be named');
});

test('the date-window params are described as CREATION time — the platform contract', () => {
  // Two different fields, and an earlier revision of this branch conflated them:
  //   • a hit's RETURNED createdAt is the search-index timestamp (later for a re-indexed item);
  //   • the createdAfter/createdBefore FILTERS are documented "created at or after" and the
  //     platform deliberately preserves that — applyTimeRange uses the row's true, unchanging
  //     createdAt for anything past its first index, and only borrows the index time AT first
  //     index as a bounded clock-skew allowance.
  // Describing the filters as index-time was backwards for exactly the re-index case it named,
  // and this test previously asserted /index/i, holding the error in place. Assert the contract.
  const hs = tools.hybrid_search.inputSchema as Record<string, z.ZodTypeAny>;
  for (const f of ['createdAfter', 'createdBefore']) {
    const d = hs[f]!.description ?? '';
    assert.match(d, /CREATED/, `${f} must state the creation-time contract`);
    assert.doesNotMatch(
      d,
      /do not read this as a source-creation filter|search index's own timestamp/,
      `${f} must not re-assert the index-time reading`,
    );
  }
  const ra = tools.rag_ask.inputSchema as Record<string, z.ZodTypeAny>;
  const searchShape = (ra.search as z.ZodOptional<z.ZodObject<z.ZodRawShape>>).unwrap().shape;
  assert.match(searchShape.createdAfter!.description ?? '', /CREATED/);

  // The hit-level field keeps the index-time note — that one IS index time.
  assert.match(tools.hybrid_search.description, /index/i);
});

test('record_batch_write states the best_effort intra-batch duplicate behaviour, not an absolute', () => {
  // duplicate_in_batch is raised by the transactional path only — writeBestEffort opens no scope,
  // so claimIntraScopeUniqueness early-returns and the second item matches what the first wrote
  // and reports `updated`. Claiming a bare "refused as a conflict" would tell an agent a
  // duplicated spreadsheet key is caught when by default it silently collapses two rows into one.
  const d = tools.record_batch_write.description;
  const ext = (tools.record_batch_write.inputSchema as Record<string, z.ZodTypeAny>);
  const itemsDesc = JSON.stringify(zodShapeToJsonSchema(tools.record_batch_write.inputSchema));
  assert.ok(ext.items, 'items present');
  assert.match(itemsDesc, /all_or_nothing/, 'the qualification must name the mode that does detect it');
  assert.match(itemsDesc, /best_effort/, 'and the default mode that does not');
  assert.doesNotMatch(
    itemsDesc,
    /externalId in the SAME batch is a different case and is refused/,
    'the unqualified "refused as a conflict" claim must be gone',
  );
  assert.ok(d.length > 20);
});

test('scopes is described by data_scope, not by the credential identity', () => {
  // The platform states the opposite of what these said: identity supplies the DEFAULT and
  // "does not limit which value you may state"; the bound is the granting clause's data_scope.
  for (const t of ['record_create', 'record_batch_write'] as const) {
    const shape = tools[t].inputSchema as Record<string, z.ZodTypeAny>;
    const raw = t === 'record_create'
      ? (shape.scopes!.description ?? '')
      : JSON.stringify(zodShapeToJsonSchema(tools[t].inputSchema));
    assert.match(raw, /data_scope/, `${t}: the real bound must be named`);
    assert.doesNotMatch(
      raw,
      /values must come from the credential's own identity/,
      `${t}: the false identity-bound claim must be gone`,
    );
  }
});
