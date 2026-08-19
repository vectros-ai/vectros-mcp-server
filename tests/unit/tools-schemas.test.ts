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
import recordUpdate from '../../src/tools/record_update.js';
import recordDelete from '../../src/tools/record_delete.js';
import lookupPrincipal from '../../src/tools/lookup_principal.js';
import versionHistory from '../../src/tools/version_history.js';

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

test('record_query rejects missing type', () => {
  const r = validate('record_query', { userId: 'usr_1' });
  assert.ok(!r.success);
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
