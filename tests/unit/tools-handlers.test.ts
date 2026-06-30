/**
 * Tool-handler behavior tests with a mocked Vectros SDK client.
 *
 * What this catches that tools-schemas.test.ts doesn't:
 *   - SDK method names typos (`client.search.contentt`)
 *   - Wrong arg-field names passed to the SDK
 *   - Response packaging (content[0].text shape, JSON.stringify pass)
 *   - Error-path: SDK throws → handler returns isError:true, doesn't rethrow
 *   - record_query mode auto-selection (list vs lookup)
 *   - hybrid_search default limit + mode + folderId passthrough
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';

import hybridSearch from '../../src/tools/hybrid_search.js';
import recordQuery from '../../src/tools/record_query.js';
import documentQuery from '../../src/tools/document_query.js';
import documentUpdate from '../../src/tools/document_update.js';
import documentDelete from '../../src/tools/document_delete.js';
import folderQuery from '../../src/tools/folder_query.js';
import folderCreate from '../../src/tools/folder_create.js';
import folderUpdate from '../../src/tools/folder_update.js';
import folderDelete from '../../src/tools/folder_delete.js';
import ragAsk from '../../src/tools/rag_ask.js';
import documentAsk from '../../src/tools/document_ask.js';
import listSchemas from '../../src/tools/list_schemas.js';
import documentGet from '../../src/tools/document_get.js';
import currentIdentity from '../../src/tools/current_identity.js';
import documentIngest from '../../src/tools/document_ingest.js';
import recordCreate from '../../src/tools/record_create.js';
import lookupPrincipal from '../../src/tools/lookup_principal.js';
import versionHistory from '../../src/tools/version_history.js';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const log = pino({ level: 'silent' });

/** Spy that records every method call for later assertions. */
function spy() {
  const calls: Array<{ method: string; args: unknown }> = [];
  return { calls, record: (method: string, args: unknown) => calls.push({ method, args }) };
}

function parsedText(result: { content: Array<{ type: string; text: string }> }): unknown {
  assert.equal(result.content[0]?.type, 'text');
  return JSON.parse(result.content[0]!.text);
}

// ============================================================================
// hybrid_search
// ============================================================================

test('hybrid_search calls client.search.content with right args + defaults', async () => {
  const s = spy();
  const client = {
    search: {
      content: async (args: unknown) => {
        s.record('search.content', args);
        return { results: [{ documentId: 'd1' }], searchTimeMs: 5, totalResults: 1 };
      },
    },
  } as never;
  const tool = hybridSearch({ client, log });

  // Minimal args — exercise the MCP defaults.
  const r1 = await tool.handler({ query: 'anxiety' }, {});
  assert.ok(!r1.isError);
  assert.equal(s.calls.length, 1);
  const a1 = s.calls[0].args as Record<string, unknown>;
  assert.equal(a1.query, 'anxiety');
  assert.equal(a1.mode, 'HYBRID', 'default mode is HYBRID');
  assert.equal(a1.limit, 3, 'MCP-specific default limit is 3 (not API 10)');
  assert.equal(a1.offset, undefined);
  assert.equal(a1.folderId, undefined);
  // Response payload reaches the partner.
  const body = parsedText(r1) as { results: unknown[] };
  assert.equal(body.results.length, 1);
});

test('hybrid_search passes through mode + limit + offset + folderId', async () => {
  const s = spy();
  const client = {
    search: {
      content: async (args: unknown) => {
        s.record('search.content', args);
        return { results: [], searchTimeMs: 0, totalResults: 0 };
      },
    },
  } as never;
  const tool = hybridSearch({ client, log });
  await tool.handler(
    { query: 'q', mode: 'SEMANTIC', limit: 7, offset: 10, folderId: 'fld_x' },
    {},
  );
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.mode, 'SEMANTIC');
  assert.equal(a.limit, 7);
  assert.equal(a.offset, 10);
  assert.equal(a.folderId, 'fld_x');
});

test('hybrid_search passes through the full launch enrichment surface', async () => {
  const s = spy();
  const client = {
    search: {
      content: async (args: unknown) => {
        s.record('search.content', args);
        return { results: [], searchTimeMs: 0, totalResults: 0 };
      },
    },
  } as never;
  const tool = hybridSearch({ client, log });
  await tool.handler(
    {
      query: 'q',
      rootFolderId: 'fld_root',
      contentTypes: ['records'],
      typeName: 'patient',
      filters: { status: 'open', price: { $gte: 100 } },
      userId: 'u1',
      orgId: 'o1',
      clientId: 'c1',
      createdAfter: '2026-01-01T00:00:00Z',
      createdBefore: '2026-12-31T00:00:00Z',
      minSimilarity: 0.42,
      uniqueDocuments: true,
    },
    {},
  );
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.rootFolderId, 'fld_root');
  assert.deepEqual(a.contentTypes, ['records']);
  assert.equal(a.typeName, 'patient');
  assert.deepEqual(a.filters, { status: 'open', price: { $gte: 100 } });
  assert.equal(a.userId, 'u1');
  assert.equal(a.orgId, 'o1');
  assert.equal(a.clientId, 'c1');
  assert.equal(a.createdAfter, '2026-01-01T00:00:00Z');
  assert.equal(a.createdBefore, '2026-12-31T00:00:00Z');
  assert.equal(a.minSimilarity, 0.42);
  assert.equal(a.uniqueDocuments, true);
});

test('hybrid_search returns isError when SDK throws', async () => {
  const client = {
    search: {
      content: async () => {
        throw new Error('upstream 503');
      },
    },
  } as never;
  const tool = hybridSearch({ client, log });
  const r = await tool.handler({ query: 'q' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /upstream 503/);
});

// ============================================================================
// record_query — mode auto-selection
// ============================================================================

test('record_query lookup mode routes through lookupRecordsByBody (POST) + unwraps {data}', async () => {
  const s = spy();
  const client = {
    records: {
      listRecords: async (args: unknown) => {
        s.record('listRecords', args);
        return { data: [], nextCursor: null };
      },
      // Lookups go through the POST body variant (sensitive-safe), NOT the GET.
      lookupRecordsByBody: async (args: unknown) => {
        s.record('lookupRecordsByBody', args);
        return { data: [{ id: 'r1' }], nextCursor: null };
      },
    },
  } as never;
  const tool = recordQuery({ client, log });
  const r = await tool.handler({ type: 'patient', field: 'externalId', value: 'p-001' }, {});
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].method, 'lookupRecordsByBody', 'POST-body lookup, not the GET variant');
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.type, 'patient');
  assert.equal(a.field, 'externalId');
  assert.equal(a.value, 'p-001');
  assert.equal(a.limit, 3, 'lookup mode is capped by the MCP limit too (token economy)');
  const body = parsedText(r) as unknown[];
  assert.ok(Array.isArray(body), 'response is a bare records array, not the page envelope');
  assert.equal(body.length, 1);
});

test('record_query lookup supports range + prefix, and rejects bad mode combos', async () => {
  const s = spy();
  const client = {
    records: {
      lookupRecordsByBody: async (args: unknown) => {
        s.record('lookupRecordsByBody', args);
        return { data: [{ id: 'r1' }], nextCursor: null };
      },
    },
  } as never;
  const tool = recordQuery({ client, log });

  // Range
  await tool.handler({ type: 'task', field: 'dueDate', from: '2026-01-01', to: '2026-12-31' }, {});
  let a = s.calls.at(-1)!.args as Record<string, unknown>;
  assert.equal(a.from, '2026-01-01');
  assert.equal(a.to, '2026-12-31');

  // Prefix
  await tool.handler({ type: 'patient', field: 'name', prefix: 'Sm' }, {});
  a = s.calls.at(-1)!.args as Record<string, unknown>;
  assert.equal(a.prefix, 'Sm');

  const before = s.calls.length;
  // No lookup shape with a field → error, no SDK call.
  const noMode = await tool.handler({ type: 'task', field: 'dueDate' }, {});
  assert.equal(noMode.isError, true);
  assert.match(noMode.content[0].text, /value.*range.*prefix|one of/i);
  // Two modes at once → error.
  const twoModes = await tool.handler({ type: 'task', field: 'dueDate', value: 'x', prefix: 'y' }, {});
  assert.equal(twoModes.isError, true);
  assert.match(twoModes.content[0].text, /mutually exclusive/i);
  // Range missing a bound → error.
  const halfRange = await tool.handler({ type: 'task', field: 'dueDate', from: '2026-01-01' }, {});
  assert.equal(halfRange.isError, true);
  assert.match(halfRange.content[0].text, /requires both/i);
  assert.equal(s.calls.length, before, 'invalid combos make no SDK call');
});

test('record_query enters list mode when only type (+ optional owner) present + unwraps {data}', async () => {
  const s = spy();
  const client = {
    records: {
      listRecords: async (args: unknown) => {
        s.record('listRecords', args);
        return { data: [{ id: 'r1' }, { id: 'r2' }], nextCursor: 'more' };
      },
      lookupRecords: async (args: unknown) => {
        s.record('lookupRecords', args);
        return { data: [], nextCursor: null };
      },
    },
  } as never;
  const tool = recordQuery({ client, log });
  const r = await tool.handler({ type: 'patient', userId: 'usr_1' }, {});
  assert.equal(s.calls.length, 1, 'list mode reads ONE page (limit is the cap; no drain)');
  assert.equal(s.calls[0].method, 'listRecords');
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.type, 'patient');
  assert.equal(a.userId, 'usr_1');
  assert.equal(a.limit, 3, 'MCP-specific default 3 (not API 100)');
  // Unwrapped to the first page's records — a non-null nextCursor does NOT
  // trigger a drain here (the MCP limit is the intended ceiling).
  const body = parsedText(r) as unknown[];
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 2);
});

test('record_query returns isError when SDK throws', async () => {
  const client = {
    records: {
      listRecords: async () => {
        throw new Error('boom');
      },
    },
  } as never;
  const tool = recordQuery({ client, log });
  const r = await tool.handler({ type: 'patient' }, {});
  assert.equal(r.isError, true);
});

// ============================================================================
// document_query — mode auto-selection (list vs equality-lookup)
// ============================================================================

test('document_query list mode routes through listDocuments + unwraps {data}', async () => {
  const s = spy();
  const client = {
    documents: {
      listDocuments: async (args: unknown) => {
        s.record('listDocuments', args);
        return { data: [{ id: 'doc1' }, { id: 'doc2' }], nextCursor: null };
      },
    },
  } as never;
  const tool = documentQuery({ client, log });
  const r = await tool.handler({ folderId: 'fld_a', userId: 'u1', limit: 5 }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls[0].method, 'listDocuments');
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.folderId, 'fld_a');
  assert.equal(a.userId, 'u1');
  assert.equal(a.limit, 5);
  const body = parsedText(r) as unknown[];
  assert.ok(Array.isArray(body), 'bare array, not the {data} envelope');
  assert.equal(body.length, 2);
});

test('document_query lookup mode routes through lookupDocumentsByBody (POST) + unwraps {data}', async () => {
  const s = spy();
  const client = {
    documents: {
      lookupDocumentsByBody: async (args: unknown) => {
        s.record('lookupDocumentsByBody', args);
        return { data: [{ id: 'doc9' }], nextCursor: null };
      },
    },
  } as never;
  const tool = documentQuery({ client, log });
  const r = await tool.handler({ type: 'invoice', field: 'mrn', value: 'MRN-1001' }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls[0].method, 'lookupDocumentsByBody');
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.type, 'invoice');
  assert.equal(a.field, 'mrn');
  assert.equal(a.value, 'MRN-1001');
  const body = parsedText(r) as unknown[];
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
});

test('document_query lookup supports range + prefix, and rejects bad mode combos / missing type', async () => {
  const s = spy();
  const client = {
    documents: {
      lookupDocumentsByBody: async (args: unknown) => {
        s.record('lookupDocumentsByBody', args);
        return { data: [{ id: 'doc1' }], nextCursor: null };
      },
      listDocuments: async () => ({ data: [], nextCursor: null }),
    },
  } as never;
  const tool = documentQuery({ client, log });

  // Range
  await tool.handler({ type: 'invoice', field: 'issued', from: '2026-01-01', to: '2026-12-31' }, {});
  let a = s.calls.at(-1)!.args as Record<string, unknown>;
  assert.equal(a.from, '2026-01-01');
  assert.equal(a.to, '2026-12-31');

  // Prefix
  await tool.handler({ type: 'invoice', field: 'po', prefix: 'PO-2026' }, {});
  a = s.calls.at(-1)!.args as Record<string, unknown>;
  assert.equal(a.prefix, 'PO-2026');

  const before = s.calls.length;
  // field with no lookup shape → error, no SDK call.
  const noMode = await tool.handler({ type: 'invoice', field: 'mrn' }, {});
  assert.equal(noMode.isError, true);
  assert.match(noMode.content[0].text, /value.*range.*prefix|one of/i);
  // Two modes at once → error.
  const twoModes = await tool.handler({ type: 'invoice', field: 'mrn', value: 'x', prefix: 'y' }, {});
  assert.equal(twoModes.isError, true);
  assert.match(twoModes.content[0].text, /mutually exclusive/i);
  // Range missing a bound → error.
  const halfRange = await tool.handler({ type: 'invoice', field: 'issued', from: '2026-01-01' }, {});
  assert.equal(halfRange.isError, true);
  assert.match(halfRange.content[0].text, /requires both/i);
  // Valid mode but missing type → error.
  const noType = await tool.handler({ field: 'mrn', value: 'MRN-1' }, {});
  assert.equal(noType.isError, true);
  assert.match(noType.content[0].text, /type/);
  assert.equal(s.calls.length, before, 'invalid combos make no SDK call');
});

test('document_query returns isError when SDK throws', async () => {
  const client = {
    documents: {
      listDocuments: async () => {
        throw new Error('boom');
      },
    },
  } as never;
  const tool = documentQuery({ client, log });
  const r = await tool.handler({}, {});
  assert.equal(r.isError, true);
});

// ============================================================================
// rag_ask
// ============================================================================

async function* ragStream() {
  yield { event: 'search_results' as const, hits: [{ id: 'd1' }] };
  yield { event: 'content_delta' as const, delta: 'Hi.' };
  yield { event: 'done' as const, inputTokens: 10, outputTokens: 2, model: 'claude-haiku-4-5' };
}

test('rag_ask calls inference.ragInference with correct args + aggregates answer', async () => {
  const s = spy();
  const client = {
    inference: {
      ragInference: async (args: unknown) => {
        s.record('ragInference', args);
        return ragStream();
      },
    },
  } as never;
  const tool = ragAsk({ client, log });
  const r = await tool.handler({ query: 'q' }, {});
  assert.ok(!r.isError);
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.query, 'q');
  const search = a.search as Record<string, unknown>;
  assert.equal(search.mode, 'HYBRID', 'rag_ask default mode');
  assert.equal(search.limit, 5, 'rag_ask default limit');
  const body = parsedText(r) as { answer: string; searchResults: unknown; usage: unknown };
  assert.equal(body.answer, 'Hi.');
  assert.ok(body.searchResults);
  assert.ok(body.usage);
});

test('rag_ask passes retrieval scoping + instructions + temperature through to the SDK', async () => {
  const s = spy();
  const client = {
    inference: {
      ragInference: async (args: unknown) => {
        s.record('ragInference', args);
        return ragStream();
      },
    },
  } as never;
  const tool = ragAsk({ client, log });
  const r = await tool.handler(
    {
      query: 'q',
      instructions: 'answer only from context',
      temperature: 0.1,
      maxTokens: 256,
      search: {
        mode: 'SEMANTIC',
        limit: 7,
        userId: 'u1',
        orgId: 'o1',
        clientId: 'c1',
        folderId: 'f1',
        rootFolderId: 'rf1',
        typeName: 'patient',
        contentTypes: ['records'],
        filters: { status: 'open' },
        createdAfter: '2024-01-01T00:00:00Z',
        requireComplete: true,
      },
    },
    {},
  );
  assert.ok(!r.isError);
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.instructions, 'answer only from context');
  assert.equal(a.temperature, 0.1);
  assert.equal(a.maxTokens, 256);
  const search = a.search as Record<string, unknown>;
  assert.equal(search.mode, 'SEMANTIC');
  assert.equal(search.limit, 7);
  assert.equal(search.userId, 'u1');
  assert.equal(search.orgId, 'o1');
  assert.equal(search.clientId, 'c1');
  assert.equal(search.folderId, 'f1');
  assert.equal(search.rootFolderId, 'rf1');
  assert.equal(search.typeName, 'patient');
  assert.deepEqual(search.contentTypes, ['records']);
  assert.deepEqual(search.filters, { status: 'open' });
  assert.equal(search.createdAfter, '2024-01-01T00:00:00Z');
  assert.equal(search.requireComplete, true);
});

test('rag_ask returns isError when SDK throws', async () => {
  const client = {
    inference: {
      ragInference: async () => {
        throw new Error('quota exceeded');
      },
    },
  } as never;
  const tool = ragAsk({ client, log });
  const r = await tool.handler({ query: 'q' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /quota exceeded/);
});

// ============================================================================
// document_ask
// ============================================================================

async function* askStream() {
  yield { event: 'document_context' as const, documentId: 'd1', chunks: 2 };
  yield { event: 'content_delta' as const, delta: 'Answer.' };
  yield { event: 'done' as const, inputTokens: 5, outputTokens: 3, model: 'claude-haiku-4-5' };
}

test('document_ask calls inference.documentAsk with correct args + aggregates answer', async () => {
  const s = spy();
  const client = {
    inference: {
      documentAsk: async (args: unknown) => {
        s.record('documentAsk', args);
        return askStream();
      },
    },
  } as never;
  const tool = documentAsk({ client, log });
  const r = await tool.handler(
    { documentId: 'd1', prompt: 'What is this?' },
    {},
  );
  assert.ok(!r.isError);
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.id, 'd1', 'documentId is sent as `id` to the SDK');
  assert.equal(a.prompt, 'What is this?');
  const body = parsedText(r) as { answer: string; documentContext: unknown };
  assert.equal(body.answer, 'Answer.');
  assert.ok(body.documentContext);
});

test('document_ask returns isError when SDK throws', async () => {
  const client = {
    inference: {
      documentAsk: async () => {
        const e = new Error('document too large') as Error & { statusCode: number };
        e.statusCode = 413;
        throw e;
      },
    },
  } as never;
  const tool = documentAsk({ client, log });
  const r = await tool.handler({ documentId: 'd1', prompt: 'q' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /413/, 'statusCode surfaces');
});

// ============================================================================
// list_schemas
// ============================================================================

test('list_schemas calls client.schemas.listSchemas + unwraps the {data} envelope to a bare array', async () => {
  const s = spy();
  const client = {
    schemas: {
      // SDK 0.23: listSchemas returns the { data, nextCursor } page envelope.
      listSchemas: async (args: unknown) => {
        s.record('listSchemas', args);
        return {
          data: [
            { id: 'sch_1', typeName: 'patient', displayName: 'Patient', fields: [] },
            { id: 'sch_2', typeName: 'clinical_note', displayName: 'Clinical Note', fields: [] },
          ],
          nextCursor: null,
        };
      },
    },
  } as never;
  const tool = listSchemas({ client, log });

  const r = await tool.handler({}, {});
  assert.ok(!r.isError);
  assert.equal(s.calls.length, 1, 'single page → one call (nextCursor null)');
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.userId, undefined);
  assert.equal(a.orgId, undefined);
  // Agent-facing output is the UNWRAPPED bare array, not the {data,nextCursor}
  // envelope — preserving the v0.1/v0.2 contract across the SDK 0.23 change.
  const body = parsedText(r) as unknown[];
  assert.ok(Array.isArray(body), 'response is a bare array, not the page envelope');
  assert.equal(body.length, 2);
});

test('list_schemas drains every page across nextCursor', async () => {
  const s = spy();
  const pages: Record<string, { data: unknown[]; nextCursor: string | null }> = {
    FIRST: { data: [{ id: 'sch_1' }, { id: 'sch_2' }], nextCursor: 'cur-1' },
    'cur-1': { data: [{ id: 'sch_3' }], nextCursor: null },
  };
  const client = {
    schemas: {
      listSchemas: async (args: { startFrom?: string }) => {
        s.record('listSchemas', args);
        return pages[args.startFrom ?? 'FIRST'];
      },
    },
  } as never;
  const tool = listSchemas({ client, log });

  const r = await tool.handler({}, {});
  assert.ok(!r.isError);
  assert.equal(s.calls.length, 2, 'drained two pages');
  assert.equal(
    (s.calls[1].args as { startFrom?: string }).startFrom,
    'cur-1',
    'second call feeds back the prior nextCursor as startFrom',
  );
  const body = parsedText(r) as unknown[];
  assert.equal(body.length, 3, 'all pages flattened into one array');
});

test('list_schemas passes through userId + orgId filters', async () => {
  const s = spy();
  const client = {
    schemas: {
      listSchemas: async (args: unknown) => {
        s.record('listSchemas', args);
        return { data: [], nextCursor: null };
      },
    },
  } as never;
  const tool = listSchemas({ client, log });
  await tool.handler({ userId: 'usr_42', orgId: 'org_clin' }, {});
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.userId, 'usr_42');
  assert.equal(a.orgId, 'org_clin');
});

test('list_schemas returns isError when SDK throws', async () => {
  const client = {
    schemas: {
      listSchemas: async () => {
        throw new Error('schemas unavailable');
      },
    },
  } as never;
  const tool = listSchemas({ client, log });
  const r = await tool.handler({}, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /schemas unavailable/);
});

// ============================================================================
// document_get
// ============================================================================

test('document_get without includeText returns metadata only (one SDK call)', async () => {
  const s = spy();
  const client = {
    documents: {
      getDocument: async (args: unknown) => {
        s.record('getDocument', args);
        return { id: 'doc_1', title: 'Hello', status: 'INDEXED' };
      },
      getDocumentText: async () => {
        s.record('getDocumentText', null);
        throw new Error('should not be called');
      },
    },
  } as never;
  const tool = documentGet({ client, log });

  const r = await tool.handler({ documentId: 'doc_1' }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls.length, 1, 'only getDocument called');
  assert.equal(s.calls[0].method, 'getDocument');
  assert.deepEqual(s.calls[0].args, { id: 'doc_1' });
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.id, 'doc_1');
  assert.equal(body.text, undefined, 'no text field when includeText false');
  assert.equal(body.textAvailable, undefined);
});

test('document_get with includeText:true fetches both metadata + text', async () => {
  const s = spy();
  const client = {
    documents: {
      getDocument: async (args: unknown) => {
        s.record('getDocument', args);
        return { id: 'doc_1', title: 'Hello' };
      },
      getDocumentText: async (args: unknown) => {
        s.record('getDocumentText', args);
        return { id: 'doc_1', text: 'Short document body.' };
      },
    },
  } as never;
  const tool = documentGet({ client, log });

  const r = await tool.handler({ documentId: 'doc_1', includeText: true }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls.length, 2);
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.text, 'Short document body.');
  assert.equal(body.truncated, false);
  assert.equal(body.textAvailable, true);
});

test('document_get with includeText truncates text > 32k chars', async () => {
  const longText = 'a'.repeat(40_000); // 40k chars > 32k cap
  const client = {
    documents: {
      getDocument: async () => ({ id: 'doc_1' }),
      getDocumentText: async () => ({ text: longText }),
    },
  } as never;
  const tool = documentGet({ client, log });
  const r = await tool.handler({ documentId: 'doc_1', includeText: true }, {});
  assert.ok(!r.isError);
  const body = parsedText(r) as { text: string; truncated: boolean };
  assert.equal(body.truncated, true, 'truncation flag set');
  assert.equal(body.text.length, 32_000, 'text capped at 32k chars (~8k tokens)');
});

test('document_get with includeText gracefully handles getText 404 (storeText not set)', async () => {
  const client = {
    documents: {
      getDocument: async () => ({ id: 'doc_1', status: 'INDEXED' }),
      getDocumentText: async () => {
        const e = new Error('document text not stored') as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      },
    },
  } as never;
  const tool = documentGet({ client, log });
  const r = await tool.handler({ documentId: 'doc_1', includeText: true }, {});
  // CRITICAL: 404-on-text is NOT a tool error — it's a normal "this
  // doc didn't store text" signal. The agent should know to use
  // document_ask instead. Tool returns success with textAvailable: false.
  assert.ok(!r.isError, 'getText 404 must NOT surface as tool error');
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.textAvailable, false);
  assert.equal(body.text, undefined);
});

test('document_get surfaces non-404 getText errors as tool error', async () => {
  const client = {
    documents: {
      getDocument: async () => ({ id: 'doc_1' }),
      getDocumentText: async () => {
        const e = new Error('upstream 503') as Error & { statusCode: number };
        e.statusCode = 503;
        throw e;
      },
    },
  } as never;
  const tool = documentGet({ client, log });
  const r = await tool.handler({ documentId: 'doc_1', includeText: true }, {});
  assert.equal(r.isError, true, '503 from getText surfaces as tool error');
  assert.match(r.content[0].text, /503/);
});

test('document_get surfaces getDocument errors as tool error', async () => {
  const client = {
    documents: {
      getDocument: async () => {
        const e = new Error('not found') as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      },
    },
  } as never;
  const tool = documentGet({ client, log });
  const r = await tool.handler({ documentId: 'doc_missing' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /404/);
});

// ============================================================================
// current_identity
//
// Tests stub globalThis.fetch since current_identity bypasses the SDK
// to read the raw /v1/ping response body (graceful-degradation
// contract — see src/tools/current_identity.ts header).
// ============================================================================

interface FetchStub {
  calls: Array<{ url: string; init?: RequestInit }>;
  restore: () => void;
}

function stubFetch(response: { status: number; body?: string }): FetchStub {
  const original = globalThis.fetch;
  const calls: FetchStub['calls'] = [];
  // @ts-expect-error — narrow override for test scope.
  globalThis.fetch = async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: `STATUS_${response.status}`,
      text: async () => response.body ?? '',
    } as Response;
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('current_identity with no apiKey/env in ctx returns derived-only', async () => {
  const tool = currentIdentity({ client: {} as never, log });
  const r = await tool.handler({}, {});
  assert.ok(!r.isError);
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.status, 'ok');
  assert.equal(body.environment, undefined, 'no env to derive from');
  assert.equal(body.principalType, undefined, 'no key to derive from');
});

test('current_identity derives environment + principalType from ctx (degraded mode — empty ping body)', async () => {
  const f = stubFetch({ status: 200, body: '' });
  try {
    const tool = currentIdentity({
      client: {} as never,
      log,
      apiKey: 'ssk_live_abc123',
      environment: 'https://api.staging.vectros.ai',
    });
    const r = await tool.handler({}, {});
    assert.ok(!r.isError);
    const body = parsedText(r) as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.equal(body.environment, 'staging', 'derived from URL substring');
    assert.equal(body.principalType, 'scoped_key', 'derived from ssk_ prefix');
    assert.equal(f.calls.length, 1, 'one fetch call');
    assert.equal(f.calls[0].url, 'https://api.staging.vectros.ai/v1/ping');
    const auth = (f.calls[0].init?.headers as Record<string, string>)?.Authorization;
    assert.equal(auth, 'Bearer ssk_live_abc123', 'Authorization header sent');
  } finally {
    f.restore();
  }
});

test('current_identity merges extended ping response over derived fields', async () => {
  // Simulate the future state where backend has shipped the extended
  // /v1/ping response — extended fields appear automatically.
  const extendedResponse = JSON.stringify({
    status: 'ok',
    tenantId: 'tenant_acme',
    environment: 'staging',
    principalType: 'scoped_key',
    principalKeyId: 'ssk_live_xyz_stable',
    principalLabel: 'Claude Desktop — RO',
    allowedActions: ['search:read', 'records:read'],
    dataScope: { orgId: 'org_clin' },
  });
  const f = stubFetch({ status: 200, body: extendedResponse });
  try {
    const tool = currentIdentity({
      client: {} as never,
      log,
      apiKey: 'ssk_live_abc123',
      environment: 'https://api.staging.vectros.ai',
    });
    const r = await tool.handler({}, {});
    assert.ok(!r.isError);
    const body = parsedText(r) as Record<string, unknown>;
    // Extended fields surface.
    assert.equal(body.tenantId, 'tenant_acme');
    assert.equal(body.principalKeyId, 'ssk_live_xyz_stable');
    assert.equal(body.principalLabel, 'Claude Desktop — RO');
    assert.deepEqual(body.allowedActions, ['search:read', 'records:read']);
    assert.deepEqual(body.dataScope, { orgId: 'org_clin' });
    // Status is always 'ok' on 2xx.
    assert.equal(body.status, 'ok');
  } finally {
    f.restore();
  }
});

test('current_identity returns isError on non-2xx ping (auth failure)', async () => {
  const f = stubFetch({ status: 401, body: 'Unauthorized' });
  try {
    const tool = currentIdentity({
      client: {} as never,
      log,
      apiKey: 'ssk_live_revoked',
      environment: 'https://api.staging.vectros.ai',
    });
    const r = await tool.handler({}, {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /401/);
  } finally {
    f.restore();
  }
});

test('current_identity silently degrades on non-JSON ping body', async () => {
  const f = stubFetch({ status: 200, body: 'pong (legacy plain-text)' });
  try {
    const tool = currentIdentity({
      client: {} as never,
      log,
      apiKey: 'sk_live_root',
      environment: 'https://api.vectros.ai',
    });
    const r = await tool.handler({}, {});
    assert.ok(!r.isError, 'non-JSON body must NOT surface as tool error');
    const body = parsedText(r) as Record<string, unknown>;
    assert.equal(body.environment, 'production', 'derived from api.vectros.ai URL');
    assert.equal(body.principalType, 'root_key', 'derived from sk_ prefix');
    assert.equal(body.status, 'ok');
  } finally {
    f.restore();
  }
});

test('current_identity derives principalType correctly for each key prefix', async () => {
  const f = stubFetch({ status: 200, body: '' });
  try {
    for (const [key, expected] of [
      ['sk_live_root', 'root_key'],
      ['ssk_live_scoped', 'scoped_key'],
      ['st_live_token', 'token'],
      ['unknown_prefix', undefined],
    ] as const) {
      const tool = currentIdentity({
        client: {} as never,
        log,
        apiKey: key,
        environment: 'https://api.staging.vectros.ai',
      });
      const r = await tool.handler({}, {});
      const body = parsedText(r) as Record<string, unknown>;
      assert.equal(body.principalType, expected, `key=${key}`);
    }
  } finally {
    f.restore();
  }
});

test('current_identity surfaces fetch network failure as tool error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const tool = currentIdentity({
      client: {} as never,
      log,
      apiKey: 'ssk_live_x',
      environment: 'https://api.staging.vectros.ai',
    });
    const r = await tool.handler({}, {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = original;
  }
});

// ============================================================================
// document_ingest
//
// Two modes: text (inline ingestDocument) + filePath (3-step upload).
// HTTP transport rejects filePath mode (locked v0.2 design).
// ============================================================================

test('document_ingest text mode calls ingestDocument with correct args + defaults', async () => {
  const s = spy();
  const client = {
    documents: {
      ingestDocument: async (args: unknown) => {
        s.record('ingestDocument', args);
        return { id: 'doc_new', title: 'T', status: 'PENDING_INDEX' };
      },
    },
  } as never;
  const tool = documentIngest({ client, log });
  const r = await tool.handler({ title: 'My Doc', text: 'Hello world.' }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls.length, 1);
  // The request body nests under `body` (SDK 0.31 un-inlined it when `?upsert` was added).
  const a = (s.calls[0].args as { body: Record<string, unknown> }).body;
  assert.equal(a.title, 'My Doc');
  assert.equal(a.text, 'Hello world.');
  assert.equal(a.indexMode, 'HYBRID', 'default indexMode is HYBRID');
  assert.equal(a.storeText, true, 'default storeText is true');
});

test('document_ingest text mode passes through indexMode + storeText + ownership + payload/schemaId/externalId', async () => {
  const s = spy();
  const client = {
    documents: {
      ingestDocument: async (args: unknown) => {
        s.record('ingestDocument', args);
        return { id: 'doc_new' };
      },
    },
  } as never;
  const tool = documentIngest({ client, log });
  await tool.handler(
    {
      title: 'X',
      text: 'body',
      indexMode: 'SEMANTIC',
      storeText: false,
      folderId: 'fld_1',
      payload: { source: 'crawl' },
      schemaId: 'sch_1',
      externalId: 'ext-1',
      userId: 'usr_1',
      orgId: 'org_1',
    },
    {},
  );
  const a = (s.calls[0].args as { body: Record<string, unknown> }).body;
  assert.equal(a.indexMode, 'SEMANTIC');
  assert.equal(a.storeText, false);
  assert.equal(a.folderId, 'fld_1');
  assert.deepEqual(a.payload, { source: 'crawl' });
  assert.equal(a.schemaId, 'sch_1');
  assert.equal(a.externalId, 'ext-1');
  assert.equal(a.userId, 'usr_1');
  assert.equal(a.orgId, 'org_1');
  // The dead `metadata` field is gone — nothing named `metadata` reaches the SDK.
  assert.equal(a.metadata, undefined, 'no stale metadata key on the wire');
});

test('document_ingest rejects when neither text nor filePath given', async () => {
  const tool = documentIngest({ client: {} as never, log });
  const r = await tool.handler({ title: 'X' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Either `text`.*or `filePath`/);
});

test('document_ingest rejects when BOTH text and filePath given', async () => {
  const tool = documentIngest({ client: {} as never, log });
  const r = await tool.handler({ title: 'X', text: 'body', filePath: '/tmp/foo' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /mutually exclusive/);
});

test('document_ingest rejects filePath on HTTP transport with actionable message', async () => {
  const tool = documentIngest({
    client: {} as never,
    log,
    transport: 'http',
  });
  const r = await tool.handler({ title: 'X', filePath: '/tmp/foo.pdf' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /filePath mode is not supported on HTTP transport/);
  assert.match(r.content[0].text, /text.*mode|uploadDocument/, 'mentions workaround');
});

test('document_ingest file mode reads + uploads + returns PENDING_INDEX', async () => {
  // Real temp file for the fs.readFile path.
  const tmpFile = join(tmpdir(), `mcp-ingest-test-${process.pid}.txt`);
  await writeFile(tmpFile, 'file body bytes');

  const sdkCalls: Array<{ method: string; args: unknown }> = [];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  // @ts-expect-error — test override.
  globalThis.fetch = async (input: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    return { ok: true, status: 200, statusText: 'OK', text: async () => '' } as Response;
  };

  try {
    const client = {
      documents: {
        uploadDocument: async (args: unknown) => {
          sdkCalls.push({ method: 'uploadDocument', args });
          return { id: 'doc_uploaded', uploadUrl: 'https://s3.example/presigned?sig=x', expiresAt: '2026-01-01T00:00:00Z' };
        },
      },
    } as never;
    const tool = documentIngest({ client, log, transport: 'stdio', ingestRoot: tmpdir() });
    const r = await tool.handler({ title: 'My File', filePath: tmpFile }, {});
    assert.ok(!r.isError, `must not error: ${JSON.stringify(r)}`);

    // SDK call: uploadDocument with inferred fileName + fileType + default indexMode.
    assert.equal(sdkCalls.length, 1);
    const a = sdkCalls[0].args as Record<string, unknown>;
    assert.equal(a.fileName, basename(tmpFile));
    assert.equal(a.fileType, 'text/plain', 'inferred .txt → text/plain');
    assert.equal(a.indexMode, 'HYBRID');

    // PUT fetch: presigned URL, no Authorization header.
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://s3.example/presigned?sig=x');
    assert.equal(fetchCalls[0].init?.method, 'PUT');
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'text/plain');
    assert.equal(headers.Authorization, undefined, 'no auth on presigned PUT');

    // Response surfaces PENDING_INDEX + polling note.
    const body = parsedText(r) as Record<string, unknown>;
    assert.equal(body.id, 'doc_uploaded');
    assert.equal(body.status, 'PENDING_INDEX');
    assert.match(String(body._note), /Poll document_get/);
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(tmpFile).catch(() => {});
  }
});

test('document_ingest file mode infers MIME from extension', async () => {
  const tmpPdf = join(tmpdir(), `mcp-test-${process.pid}.pdf`);
  await writeFile(tmpPdf, Buffer.from('%PDF-1.4'));

  let capturedFileType: string | undefined;
  const client = {
    documents: {
      uploadDocument: async (args: unknown) => {
        capturedFileType = (args as { fileType?: string }).fileType;
        return { id: 'd', uploadUrl: 'https://x/y' };
      },
    },
  } as never;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' }) as Response;

  try {
    const tool = documentIngest({ client, log, transport: 'stdio', ingestRoot: tmpdir() });
    await tool.handler({ title: 'X', filePath: tmpPdf }, {});
    assert.equal(capturedFileType, 'application/pdf', '.pdf → application/pdf');
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(tmpPdf).catch(() => {});
  }
});

test('document_ingest file mode honors explicit fileType override', async () => {
  const tmpFile = join(tmpdir(), `mcp-test-${process.pid}.bin`);
  await writeFile(tmpFile, Buffer.from([0, 1, 2]));

  let capturedFileType: string | undefined;
  const client = {
    documents: {
      uploadDocument: async (args: unknown) => {
        capturedFileType = (args as { fileType?: string }).fileType;
        return { id: 'd', uploadUrl: 'https://x/y' };
      },
    },
  } as never;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' }) as Response;

  try {
    const tool = documentIngest({ client, log, transport: 'stdio', ingestRoot: tmpdir() });
    await tool.handler(
      { title: 'X', filePath: tmpFile, fileType: 'application/x-custom' },
      {},
    );
    assert.equal(capturedFileType, 'application/x-custom', 'explicit override beats inference');
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(tmpFile).catch(() => {});
  }
});

test('document_ingest file mode returns isError if filePath does not exist', async () => {
  const tool = documentIngest({
    client: {} as never,
    log,
    transport: 'stdio',
  });
  const r = await tool.handler(
    { title: 'X', filePath: '/tmp/this-file-definitely-does-not-exist-' + Date.now() },
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Cannot read filePath/);
});

test('document_ingest file mode returns isError when presigned PUT fails', async () => {
  const tmpFile = join(tmpdir(), `mcp-test-${process.pid}-put-fail.txt`);
  await writeFile(tmpFile, 'body');

  const client = {
    documents: {
      uploadDocument: async () => ({ id: 'd', uploadUrl: 'https://x/y' }),
    },
  } as never;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    text: async () => 'Signature mismatch',
  }) as Response;

  try {
    const tool = documentIngest({ client, log, transport: 'stdio', ingestRoot: tmpdir() });
    const r = await tool.handler({ title: 'X', filePath: tmpFile }, {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /403/);
    assert.match(r.content[0].text, /upload did not complete/);
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(tmpFile).catch(() => {});
  }
});

test('document_ingest file mode returns isError on malformed uploadDocument response', async () => {
  const tmpFile = join(tmpdir(), `mcp-test-${process.pid}-malformed.txt`);
  await writeFile(tmpFile, 'body');

  const client = {
    documents: {
      // Missing uploadUrl + id — caught by the structured-response check.
      uploadDocument: async () => ({ expiresAt: 'ts' }),
    },
  } as never;

  try {
    const tool = documentIngest({ client, log, transport: 'stdio', ingestRoot: tmpdir() });
    const r = await tool.handler({ title: 'X', filePath: tmpFile }, {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /missing uploadUrl or id/);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
});

test('document_ingest surfaces ingestDocument SDK errors as tool error', async () => {
  const client = {
    documents: {
      ingestDocument: async () => {
        const e = new Error('quota exceeded') as Error & { statusCode: number };
        e.statusCode = 429;
        throw e;
      },
    },
  } as never;
  const tool = documentIngest({ client, log });
  const r = await tool.handler({ title: 'X', text: 'body' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /429/);
});

// ============================================================================
// document_update — RFC-7386 merge-patch + optimistic concurrency
// ============================================================================

test('document_update sends fields as the merge-patch payload (no read-modify-write, title omitted)', async () => {
  const s = spy();
  const client = {
    documents: {
      // getDocument must NOT be called — PATCH merges + preserves server-side.
      getDocument: async (args: unknown) => {
        s.record('getDocument', args);
        return {};
      },
      patchDocument: async (args: unknown) => {
        s.record('patchDocument', args);
        return { id: 'doc1', version: 8 };
      },
    },
  } as never;
  const tool = documentUpdate({ client, log });
  // Only patch payload fields; title omitted → preserved server-side (not carried forward by us).
  const r = await tool.handler({ documentId: 'doc1', fields: { b: 99, c: 3 } }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls.find((c) => c.method === 'getDocument'), undefined, 'no read-modify-write');
  const upd = s.calls.find((c) => c.method === 'patchDocument')!.args as { id: string; body: Record<string, unknown> };
  assert.equal(upd.id, 'doc1');
  assert.deepEqual(upd.body.payload, { b: 99, c: 3 }, 'fields sent verbatim for the server to deep-merge');
  assert.equal(upd.body.title, undefined, 'title omitted when not changing it (server preserves)');
  assert.equal(upd.body.expectedVersion, undefined, 'no version pin when the caller omits expectedVersion');
});

test('document_update forwards title/folderId/ownership; omits payload when no fields given', async () => {
  const s = spy();
  const client = {
    documents: {
      patchDocument: async (args: unknown) => {
        s.record('patchDocument', args);
        return { id: 'doc1', version: 3 };
      },
    },
  } as never;
  const tool = documentUpdate({ client, log });
  const r = await tool.handler(
    { documentId: 'doc1', title: 'New Title', folderId: 'fld_new', storeText: true, userId: 'u9', orgId: 'o9', clientId: 'c9' },
    {},
  );
  assert.ok(!r.isError);
  const upd = s.calls[0].args as { body: Record<string, unknown> };
  assert.equal(upd.body.title, 'New Title');
  assert.equal(upd.body.folderId, 'fld_new');
  assert.equal(upd.body.storeText, true, 'storeText forwarded');
  assert.equal(upd.body.userId, 'u9', 'ownership reassignment forwarded');
  assert.equal(upd.body.orgId, 'o9');
  assert.equal(upd.body.clientId, 'c9');
  assert.equal(upd.body.payload, undefined, 'no fields → payload omitted (preserved, not wiped)');
});

test('document_update forwards a null payload field (merge-patch key deletion)', async () => {
  const s = spy();
  const client = {
    documents: {
      patchDocument: async (args: unknown) => {
        s.record('patchDocument', args);
        return { id: 'doc1', version: 4 };
      },
    },
  } as never;
  const tool = documentUpdate({ client, log });
  const r = await tool.handler({ documentId: 'doc1', fields: { stale: null, keep: 'v' } }, {});
  assert.ok(!r.isError);
  const upd = s.calls[0].args as { body: { payload: Record<string, unknown> } };
  assert.equal(upd.body.payload.stale, null, 'null forwarded so the server deletes the key (RFC-7386)');
  assert.equal(upd.body.payload.keep, 'v');
});

test('document_update forwards expectedVersion; server enforces the conflict (409 → isError)', async () => {
  const s = spy();
  const client = {
    documents: {
      patchDocument: async (args: unknown) => {
        s.record('patchDocument', args);
        const e = new Error('VERSION_CONFLICT') as Error & { statusCode: number };
        e.statusCode = 409;
        throw e;
      },
    },
  } as never;
  const tool = documentUpdate({ client, log });
  const r = await tool.handler({ documentId: 'doc1', fields: { x: 1 }, expectedVersion: 5 }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /409|conflict/i);
  const upd = s.calls[0].args as { body: Record<string, unknown> };
  assert.equal(upd.body.expectedVersion, 5, 'caller version forwarded for server-side optimistic concurrency');
});

test('document_update returns isError when SDK throws', async () => {
  const client = {
    documents: {
      patchDocument: async () => {
        const e = new Error('not found') as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      },
    },
  } as never;
  const tool = documentUpdate({ client, log });
  const r = await tool.handler({ documentId: 'nope', fields: {} }, {});
  assert.equal(r.isError, true);
});

// ============================================================================
// document_delete
// ============================================================================

test('document_delete calls deleteDocument and returns {deleted,id}', async () => {
  const s = spy();
  const client = {
    documents: {
      deleteDocument: async (args: unknown) => {
        s.record('deleteDocument', args);
      },
    },
  } as never;
  const tool = documentDelete({ client, log });
  const r = await tool.handler({ documentId: 'doc1' }, {});
  assert.ok(!r.isError);
  assert.deepEqual(s.calls[0].args, { id: 'doc1' });
  const body = parsedText(r) as { deleted: boolean; id: string };
  assert.equal(body.deleted, true);
  assert.equal(body.id, 'doc1');
});

test('document_delete surfaces a scope/permission error as isError', async () => {
  const client = {
    documents: {
      deleteDocument: async () => {
        throw new Error('403 your key lacks documents:d');
      },
    },
  } as never;
  const tool = documentDelete({ client, log });
  const r = await tool.handler({ documentId: 'doc1' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /documents:d/);
});

// ============================================================================
// folder_query — get (id) vs list mode
// ============================================================================

test('folder_query get mode fetches one folder by id', async () => {
  const s = spy();
  const client = {
    folders: {
      getFolder: async (args: unknown) => {
        s.record('getFolder', args);
        return { id: 'fld1', name: 'Patients' };
      },
    },
  } as never;
  const tool = folderQuery({ client, log });
  const r = await tool.handler({ id: 'fld1' }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls[0].method, 'getFolder');
  const body = parsedText(r) as { id: string };
  assert.equal(body.id, 'fld1');
});

test('folder_query list mode returns {data, nextCursor} + maps parentId→parentFolderId + passes startFrom', async () => {
  const s = spy();
  const client = {
    folders: {
      listFolders: async (args: unknown) => {
        s.record('listFolders', args);
        return { data: [{ id: 'f1' }, { id: 'f2' }], nextCursor: 'cur_next' };
      },
    },
  } as never;
  const tool = folderQuery({ client, log });
  const r = await tool.handler({ parentId: 'root', limit: 5, startFrom: 'cur_prev' }, {});
  assert.ok(!r.isError);
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.parentFolderId, 'root', 'agent-facing parentId maps to SDK parentFolderId');
  assert.equal(a.limit, 5);
  assert.equal(a.startFrom, 'cur_prev', 'startFrom cursor forwarded');
  const body = parsedText(r) as { data: unknown[]; nextCursor: string | null };
  assert.ok(Array.isArray(body.data));
  assert.equal(body.data.length, 2);
  assert.equal(body.nextCursor, 'cur_next', 'nextCursor surfaced for pagination');
});

test('folder_query returns isError when SDK throws', async () => {
  const client = {
    folders: {
      listFolders: async () => {
        throw new Error('boom');
      },
    },
  } as never;
  const tool = folderQuery({ client, log });
  const r = await tool.handler({}, {});
  assert.equal(r.isError, true);
});

// ============================================================================
// folder_create
// ============================================================================

test('folder_create passes name/description + maps parentId→parentFolderId', async () => {
  const s = spy();
  const client = {
    folders: {
      createFolder: async (args: unknown) => {
        s.record('createFolder', args);
        return { id: 'fld_new', name: 'Reports' };
      },
    },
  } as never;
  const tool = folderCreate({ client, log });
  const r = await tool.handler(
    { name: 'Reports', description: 'Q4', parentId: 'root', slug: 'reports', userId: 'u1', orgId: 'o1', clientId: 'c1' },
    {},
  );
  assert.ok(!r.isError);
  // The request body nests under `body` (SDK 0.31 un-inlined it when `?upsert` was added).
  const a = (s.calls[0].args as { body: Record<string, unknown> }).body;
  assert.equal(a.name, 'Reports');
  assert.equal(a.description, 'Q4');
  assert.equal(a.parentFolderId, 'root');
  assert.equal(a.slug, 'reports', 'slug forwarded');
  assert.equal(a.userId, 'u1', 'ownership forwarded');
  assert.equal(a.orgId, 'o1');
  assert.equal(a.clientId, 'c1');
  const body = parsedText(r) as { id: string };
  assert.equal(body.id, 'fld_new');
});

test('folder_create returns isError when SDK throws', async () => {
  const client = {
    folders: {
      createFolder: async () => {
        throw new Error('409 slug exists');
      },
    },
  } as never;
  const tool = folderCreate({ client, log });
  const r = await tool.handler({ name: 'Reports' }, {});
  assert.equal(r.isError, true);
});

// ============================================================================
// folder_update — RFC-7386 merge patch; no read-to-carry-name; no re-parenting
// ============================================================================

test('folder_update merge-patches only changed fields (no GET round-trip); never sends parentFolderId', async () => {
  const s = spy();
  const client = {
    folders: {
      getFolder: async () => {
        throw new Error('folder_update must NOT GET — PATCH does not require name');
      },
      patchFolder: async (args: unknown) => {
        s.record('patchFolder', args);
        return { id: 'fld1', description: 'new desc' };
      },
    },
  } as never;
  const tool = folderUpdate({ client, log });
  const r = await tool.handler({ id: 'fld1', description: 'new desc' }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls.length, 1, 'exactly one SDK call — patchFolder, no getFolder');
  const upd = s.calls[0].args as { id: string; body: Record<string, unknown> };
  assert.equal(upd.id, 'fld1');
  assert.equal(upd.body.description, 'new desc');
  assert.ok(!('name' in upd.body), 'name omitted when unchanged (PATCH preserves it)');
  assert.ok(!('parentFolderId' in upd.body), 'never sends parentFolderId — folders cannot be moved');
});

test('folder_update forwards expectedVersion + ownership for optimistic concurrency', async () => {
  const s = spy();
  const client = {
    folders: {
      patchFolder: async (args: unknown) => {
        s.record('patchFolder', args);
        return { id: 'fld1', name: 'Renamed' };
      },
    },
  } as never;
  const tool = folderUpdate({ client, log });
  const r = await tool.handler(
    { id: 'fld1', name: 'Renamed', userId: 'u1', orgId: 'o1', clientId: 'c1', expectedVersion: 7 },
    {},
  );
  assert.ok(!r.isError);
  const upd = s.calls[0].args as { id: string; body: Record<string, unknown> };
  assert.equal(upd.body.name, 'Renamed');
  assert.equal(upd.body.userId, 'u1');
  assert.equal(upd.body.orgId, 'o1');
  assert.equal(upd.body.clientId, 'c1');
  assert.equal(upd.body.expectedVersion, 7, 'expectedVersion forwarded for the 409 conflict path');
});

test('folder_update returns isError when SDK throws', async () => {
  const client = {
    folders: {
      patchFolder: async () => {
        throw new Error('not found');
      },
    },
  } as never;
  const tool = folderUpdate({ client, log });
  const r = await tool.handler({ id: 'nope', name: 'X' }, {});
  assert.equal(r.isError, true);
});

test('folder_update surfaces a stale-expectedVersion 409 conflict verbatim', async () => {
  const client = {
    folders: {
      patchFolder: async () => {
        throw new Error('409 VERSION_CONFLICT: the folder was modified since the expectedVersion you supplied');
      },
    },
  } as never;
  const tool = folderUpdate({ client, log });
  const r = await tool.handler({ id: 'fld1', name: 'X', expectedVersion: 3 }, {});
  assert.equal(r.isError, true, 'stale expectedVersion → conflict');
  assert.match(r.content[0].text, /409|conflict/i, 'backend conflict message reaches the caller');
});

// ============================================================================
// folder_delete
// ============================================================================

test('folder_delete calls deleteFolder and returns {deleted,id}', async () => {
  const s = spy();
  const client = {
    folders: {
      deleteFolder: async (args: unknown) => {
        s.record('deleteFolder', args);
      },
    },
  } as never;
  const tool = folderDelete({ client, log });
  const r = await tool.handler({ id: 'fld1' }, {});
  assert.ok(!r.isError);
  assert.deepEqual(s.calls[0].args, { id: 'fld1' });
  const body = parsedText(r) as { deleted: boolean; id: string };
  assert.equal(body.deleted, true);
  assert.equal(body.id, 'fld1');
});

test('folder_delete surfaces a protected-folder / scope error as isError', async () => {
  const client = {
    folders: {
      deleteFolder: async () => {
        throw new Error('409 folder is protected');
      },
    },
  } as never;
  const tool = folderDelete({ client, log });
  const r = await tool.handler({ id: 'root' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /protected/);
});

// ============================================================================
// MCP parity sweep — new fields + tools
// ============================================================================

// ── document_ingest: externalId idempotency + typed payload + indexMode ──────

test('document_ingest forwards externalId/schemaId/payload on the FILE (upload) path', async () => {
  const s = spy();
  const tmpFile = join(tmpdir(), `mcp-ingest-extid-${process.pid}.txt`);
  await writeFile(tmpFile, 'bytes');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => '' })) as never;
  try {
    const client = {
      documents: {
        uploadDocument: async (args: unknown) => {
          s.record('uploadDocument', args);
          return { id: 'doc_file', uploadUrl: 'https://example/put' };
        },
      },
    } as never;
    const tool = documentIngest({ client, log, ingestRoot: tmpdir() });
    const r = await tool.handler(
      { title: 'X', filePath: basename(tmpFile), externalId: 'ext-9', schemaId: 'sch_2', payload: { a: 1 } },
      {},
    );
    assert.ok(!r.isError);
    const a = s.calls[0].args as Record<string, unknown>;
    assert.equal(a.externalId, 'ext-9', 'externalId reaches uploadDocument (idempotent upload)');
    assert.equal(a.schemaId, 'sch_2');
    assert.deepEqual(a.payload, { a: 1 });
  } finally {
    globalThis.fetch = realFetch;
    await unlink(tmpFile).catch(() => {});
  }
});

test('document_ingest is idempotent by externalId: re-ingest returns the existing doc (no duplicate)', async () => {
  // The API resolves idempotency; the tool must surface the SAME id the SDK returns.
  const existing = { id: 'doc_existing', externalId: 'ext-dup', title: 'X' };
  const client = {
    documents: { ingestDocument: async () => existing },
  } as never;
  const tool = documentIngest({ client, log });
  const r = await tool.handler({ title: 'X', text: 'body', externalId: 'ext-dup' }, {});
  assert.ok(!r.isError);
  const body = parsedText(r) as { id: string };
  assert.equal(body.id, 'doc_existing', 're-ingest returns the existing document id, not a new one');
});

test('document_ingest inherits the schema default indexMode when schemaId is set + indexMode omitted', async () => {
  const s = spy();
  const client = {
    documents: { ingestDocument: async (args: unknown) => { s.record('ingestDocument', args); return { id: 'd' }; } },
  } as never;
  const tool = documentIngest({ client, log });
  await tool.handler({ title: 'X', text: 'b', schemaId: 'sch_3' }, {});
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.indexMode, undefined, 'with a schema bound, omit indexMode so the schema default is inherited');
});

test('document_ingest keeps the legacy HYBRID default for an untyped doc, and honors explicit NONE', async () => {
  const s = spy();
  const client = {
    documents: { ingestDocument: async (args: unknown) => { s.record('ingestDocument', args); return { id: 'd' }; } },
  } as never;
  const tool = documentIngest({ client, log });
  await tool.handler({ title: 'X', text: 'b' }, {}); // untyped, no indexMode
  // The request body nests under `body` (SDK 0.31 un-inlined it when `?upsert` was added).
  assert.equal((s.calls[0].args as { body: Record<string, unknown> }).body.indexMode, 'HYBRID');
  await tool.handler({ title: 'X', text: 'b', indexMode: 'NONE' }, {}); // store-only
  assert.equal((s.calls[1].args as { body: Record<string, unknown> }).body.indexMode, 'NONE');
});

test('document_ingest surfaces a backend error message verbatim (error observability)', async () => {
  const client = {
    documents: {
      ingestDocument: async () => {
        throw new Error("A document with externalId='ext-dup' already exists in this context.");
      },
    },
  } as never;
  const tool = documentIngest({ client, log });
  const r = await tool.handler({ title: 'X', text: 'b', externalId: 'ext-dup' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /already exists in this context/, 'backend message passes through to the caller');
});

// ── record_create: indexMode ─────────────────────────────────────────────────

test('record_create forwards indexMode (incl NONE) to createRecord', async () => {
  const s = spy();
  const client = {
    records: { createRecord: async (args: unknown) => { s.record('createRecord', args); return { id: 'r1' }; } },
  } as never;
  const tool = recordCreate({ client, log });
  await tool.handler({ type: 'task', fields: { a: 1 }, indexMode: 'NONE' }, {});
  // The request body nests under `body` (SDK 0.31 un-inlined it when `?upsert` was added).
  assert.equal((s.calls[0].args as { body: Record<string, unknown> }).body.indexMode, 'NONE');
});

// ── record_query / document_query: order on lookups ──────────────────────────

test('record_query forwards order on lookup mode', async () => {
  const s = spy();
  const client = {
    records: { lookupRecordsByBody: async (args: unknown) => { s.record('lookup', args); return { data: [] }; } },
  } as never;
  const tool = recordQuery({ client, log });
  await tool.handler({ type: 'visit', field: 'date', from: '2024-01-01', to: '2024-12-31', order: 'desc' }, {});
  assert.equal((s.calls[0].args as Record<string, unknown>).order, 'desc', 'desc → latest-first range lookup');
});

test('document_query forwards order on lookup mode', async () => {
  const s = spy();
  const client = {
    documents: { lookupDocumentsByBody: async (args: unknown) => { s.record('lookup', args); return { data: [] }; } },
  } as never;
  const tool = documentQuery({ client, log });
  await tool.handler({ type: 'invoice', field: 'po', prefix: 'PO-2024', order: 'desc' }, {});
  assert.equal((s.calls[0].args as Record<string, unknown>).order, 'desc');
});

// ── list_schemas: surface + recordType ───────────────────────────────────────

test('list_schemas forwards surface + recordType filters', async () => {
  const s = spy();
  const client = {
    schemas: { listSchemas: async (args: unknown) => { s.record('listSchemas', args); return { data: [], nextCursor: null }; } },
  } as never;
  const tool = listSchemas({ client, log });
  await tool.handler({ surface: 'document', recordType: 'invoice' }, {});
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.surface, 'document');
  assert.equal(a.recordType, 'invoice');
});

// ── hybrid_search: precision knobs ───────────────────────────────────────────

test('hybrid_search forwards textMode + minTextRelevance + requireComplete', async () => {
  const s = spy();
  const client = {
    search: { content: async (args: unknown) => { s.record('content', args); return { results: [] }; } },
  } as never;
  const tool = hybridSearch({ client, log });
  await tool.handler({ query: 'q', textMode: 'AND', minTextRelevance: 0.4, requireComplete: true }, {});
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.textMode, 'AND');
  assert.equal(a.minTextRelevance, 0.4);
  assert.equal(a.requireComplete, true);
});

// ── document_get: includeDownloadUrl ─────────────────────────────────────────

test('document_get includeDownloadUrl returns a downloadUrl, independent of includeText', async () => {
  const client = {
    documents: {
      getDocument: async () => ({ id: 'd1', title: 'X' }),
      getDocumentDownloadUrl: async () => ({ id: 'd1', downloadUrl: 'https://example/dl', expires: 123, fileType: 'application/pdf' }),
    },
  } as never;
  const tool = documentGet({ client, log });
  const r = await tool.handler({ documentId: 'd1', includeDownloadUrl: true }, {});
  assert.ok(!r.isError);
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.downloadUrl, 'https://example/dl');
  assert.equal(body.downloadAvailable, true);
  assert.equal(body.text, undefined, 'includeText not requested → no text field');
});

test('document_get flags downloadAvailable:false for a text-only document (404/400), not isError', async () => {
  const client = {
    documents: {
      getDocument: async () => ({ id: 'd1' }),
      getDocumentDownloadUrl: async () => {
        const e = new Error('not a file document') as Error & { statusCode?: number };
        e.statusCode = 404;
        throw e;
      },
    },
  } as never;
  const tool = documentGet({ client, log });
  const r = await tool.handler({ documentId: 'd1', includeDownloadUrl: true }, {});
  assert.ok(!r.isError, 'a missing file is a flag, not an error');
  const body = parsedText(r) as Record<string, unknown>;
  assert.equal(body.downloadAvailable, false);
});

// ── lookup_principal ─────────────────────────────────────────────────────────

test('lookup_principal resolve mode: externalId → list{Kind} for user/org/client', async () => {
  const s = spy();
  const client = {
    identity: {
      listUsers: async (a: unknown) => { s.record('listUsers', a); return { data: [{ id: 'u-uuid' }] }; },
      listOrgs: async (a: unknown) => { s.record('listOrgs', a); return { data: [{ id: 'o-uuid' }] }; },
      listClients: async (a: unknown) => { s.record('listClients', a); return { data: [{ id: 'c-uuid' }] }; },
    },
  } as never;
  const tool = lookupPrincipal({ client, log });

  const ru = await tool.handler({ kind: 'user', externalId: 'usr_1' }, {});
  assert.ok(!ru.isError);
  assert.equal(s.calls[0].method, 'listUsers');
  assert.equal((s.calls[0].args as Record<string, unknown>).externalId, 'usr_1');
  assert.deepEqual(parsedText(ru), [{ id: 'u-uuid' }], 'resolve returns the principal incl. its UUID');

  await tool.handler({ kind: 'org', externalId: 'org_1' }, {});
  assert.equal(s.calls[1].method, 'listOrgs');
  await tool.handler({ kind: 'client', externalId: 'cli_1' }, {});
  assert.equal(s.calls[2].method, 'listClients');
});

test('lookup_principal lookup mode: type+field+value → lookup{Kind} (POST body, sensitive-safe)', async () => {
  const s = spy();
  const client = {
    identity: {
      lookupUsers: async (a: unknown) => { s.record('lookupUsers', a); return { data: [{ id: 'u' }] }; },
    },
  } as never;
  const tool = lookupPrincipal({ client, log });
  const r = await tool.handler({ kind: 'user', type: 'person_v1', field: 'email', value: 'lookup-val' }, {});
  assert.ok(!r.isError);
  assert.equal(s.calls[0].method, 'lookupUsers');
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.type, 'person_v1');
  assert.equal(a.field, 'email');
  assert.equal(a.value, 'lookup-val');
});

test('lookup_principal validates lookup args (missing mode, conflicting modes, missing type)', async () => {
  const tool = lookupPrincipal({ client: {} as never, log });
  const r1 = await tool.handler({ kind: 'user', field: 'email' }, {});
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /needs one of/);
  const r2 = await tool.handler({ kind: 'user', field: 'email', value: 'x', prefix: 'y' }, {});
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /mutually exclusive/);
  const r3 = await tool.handler({ kind: 'user', field: 'email', value: 'x' }, {});
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /requires 'type'/);
  // range lookup needs BOTH from and to (validation runs before any SDK call)
  const r5 = await tool.handler({ kind: 'user', type: 'person_v1', field: 'age', from: '18' }, {});
  assert.equal(r5.isError, true);
  assert.match(r5.content[0].text, /requires both 'from' and 'to'/);
  const r4 = await tool.handler({ kind: 'user' }, {}); // neither externalId nor field
  assert.equal(r4.isError, true);
  assert.match(r4.content[0].text, /externalId.*or.*type.*field/s);
});

test('lookup_principal forwards range/prefix/order to the lookup POST body', async () => {
  const s = spy();
  const client = {
    identity: { lookupClients: async (a: unknown) => { s.record('lookupClients', a); return { data: [] }; } },
  } as never;
  const tool = lookupPrincipal({ client, log });
  await tool.handler({ kind: 'client', type: 'client_v1', field: 'tier', prefix: 'gold', order: 'desc' }, {});
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.prefix, 'gold');
  assert.equal(a.order, 'desc');
});

test('lookup_principal: externalId wins when both externalId and a field lookup are given', async () => {
  const s = spy();
  const client = {
    identity: {
      listUsers: async (a: unknown) => { s.record('listUsers', a); return { data: [{ id: 'u' }] }; },
      lookupUsers: async (a: unknown) => { s.record('lookupUsers', a); return { data: [] }; },
    },
  } as never;
  const tool = lookupPrincipal({ client, log });
  const r = await tool.handler(
    { kind: 'user', externalId: 'usr_1', type: 'person_v1', field: 'email', value: 'lookup-val' },
    {},
  );
  assert.ok(!r.isError);
  assert.equal(s.calls.length, 1, 'exactly one call');
  assert.equal(s.calls[0].method, 'listUsers', 'externalId resolve takes precedence over the field lookup');
});

test('lookup_principal surfaces a backend error verbatim', async () => {
  const client = {
    identity: { listUsers: async () => { throw new Error('Insufficient scope: users:r'); } },
  } as never;
  const tool = lookupPrincipal({ client, log });
  const r = await tool.handler({ kind: 'user', externalId: 'usr_1' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Insufficient scope/);
});

// ── version_history ──────────────────────────────────────────────────────────

test('version_history dispatches record vs document and returns {data, nextCursor}', async () => {
  const s = spy();
  const client = {
    records: { getRecordVersions: async (a: unknown) => { s.record('getRecordVersions', a); return { data: [{ v: 1 }], nextCursor: 'n1' }; } },
    documents: { getDocumentVersions: async (a: unknown) => { s.record('getDocumentVersions', a); return { data: [{ v: 2 }], nextCursor: null }; } },
  } as never;
  const tool = versionHistory({ client, log });

  const rr = await tool.handler({ resourceType: 'record', id: 'r1', startFrom: 'cur' }, {});
  assert.ok(!rr.isError);
  assert.equal(s.calls[0].method, 'getRecordVersions');
  assert.equal((s.calls[0].args as Record<string, unknown>).startFrom, 'cur');
  const br = parsedText(rr) as { data: unknown[]; nextCursor: string | null };
  assert.equal(br.data.length, 1);
  assert.equal(br.nextCursor, 'n1');

  const rd = await tool.handler({ resourceType: 'document', id: 'd1' }, {});
  assert.equal(s.calls[1].method, 'getDocumentVersions');
  assert.equal((parsedText(rd) as { nextCursor: string | null }).nextCursor, null);
});

test('version_history surfaces a backend error as isError', async () => {
  const client = {
    records: { getRecordVersions: async () => { throw new Error('Not found: r1'); } },
  } as never;
  const tool = versionHistory({ client, log });
  const r = await tool.handler({ resourceType: 'record', id: 'r1' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Not found/);
});
