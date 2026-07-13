/**
 * Ownership-scope exposure (SDK 0.34): the `scopes` create field and the
 * `scope` filter, across every tool that carries them.
 *
 *   creates  — record_create / document_ingest / folder_create pass `scopes`
 *              through verbatim (including the meaningful `[]` = private tier),
 *              and omit it when the caller does (full-identity default).
 *   filters  — record_query / document_query (list mode), hybrid_search, and
 *              rag_ask (retrieval config) pass `scope` through.
 *
 * Folder LISTS deliberately have no scope filter (not on the API) — no test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';

import recordCreate from '../../src/tools/record_create.js';
import documentIngest from '../../src/tools/document_ingest.js';
import folderCreate from '../../src/tools/folder_create.js';
import recordQuery from '../../src/tools/record_query.js';
import documentQuery from '../../src/tools/document_query.js';
import hybridSearch from '../../src/tools/hybrid_search.js';
import ragAsk from '../../src/tools/rag_ask.js';

const log = pino({ level: 'silent' });

function spy() {
  const calls: Array<{ method: string; args: unknown }> = [];
  return { calls, record: (method: string, args: unknown) => calls.push({ method, args }) };
}

// ── creates: `scopes` passthrough ────────────────────────────────────────────

test('record_create passes scopes through (team tier) and omits when absent (default stamp)', async () => {
  const s = spy();
  const client = {
    records: {
      createRecord: async (args: unknown) => {
        s.record('createRecord', args);
        return { id: 'rec1' };
      },
    },
  } as never;
  const tool = recordCreate({ client, log });

  await tool.handler({ type: 'memory', fields: { title: 't' }, scopes: ['org:6ba7b810'] }, {});
  const b1 = (s.calls[0].args as { body: Record<string, unknown> }).body;
  assert.deepEqual(b1.scopes, ['org:6ba7b810']);

  await tool.handler({ type: 'memory', fields: { title: 't' } }, {});
  const b2 = (s.calls[1].args as { body: Record<string, unknown> }).body;
  assert.equal(b2.scopes, undefined, 'omitted scopes must stay omitted (full-identity default)');
});

test('record_create passes scopes:[] through (the PRIVATE tier — not dropped as falsy)', async () => {
  const s = spy();
  const client = {
    records: {
      createRecord: async (args: unknown) => {
        s.record('createRecord', args);
        return { id: 'rec1' };
      },
    },
  } as never;
  const tool = recordCreate({ client, log });
  await tool.handler({ type: 'memory', fields: { title: 't' }, scopes: [] }, {});
  const body = (s.calls[0].args as { body: Record<string, unknown> }).body;
  assert.deepEqual(body.scopes, [], 'empty array is meaningful (private tier) and must survive');
});

test('document_ingest (text mode) passes scopes through', async () => {
  const s = spy();
  const client = {
    documents: {
      ingestDocument: async (args: unknown) => {
        s.record('ingestDocument', args);
        return { id: 'doc1' };
      },
    },
  } as never;
  const tool = documentIngest({ client, log });
  const r = await tool.handler(
    { title: 'T', text: 'body', scopes: ['org:6ba7b810', 'group:eng-team'] },
    {},
  );
  assert.ok(!r.isError);
  const body = (s.calls[0].args as { body: Record<string, unknown> }).body;
  assert.deepEqual(body.scopes, ['org:6ba7b810', 'group:eng-team']);
});

test('document_ingest (file mode) REJECTS scopes — never silently dropped (tier escalation)', async () => {
  // The upload-init endpoint has no scopes field: passing it through would be
  // silently ignored, and `scopes: []` (private) would escalate to full-identity
  // (team-visible). The tool must fail loud instead.
  let uploadCalled = false;
  const client = {
    documents: {
      ingestDocument: async () => ({ id: 'doc1' }),
      uploadDocument: async () => ((uploadCalled = true), { id: 'doc1', uploadUrl: 'https://x' }),
    },
  } as never;
  const tool = documentIngest({ client, log });
  const r = await tool.handler({ title: 'T', filePath: 'notes.md', scopes: [] }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /scopes.*not supported with.*filePath/i);
  assert.equal(uploadCalled, false, 'must reject before any upload call');
});

test('folder_create passes scopes through', async () => {
  const s = spy();
  const client = {
    folders: {
      createFolder: async (args: unknown) => {
        s.record('createFolder', args);
        return { id: 'fld1', name: 'N' };
      },
    },
  } as never;
  const tool = folderCreate({ client, log });
  await tool.handler({ name: 'N', scopes: [] }, {});
  const body = (s.calls[0].args as { body: Record<string, unknown> }).body;
  assert.deepEqual(body.scopes, []);
});

// ── filters: `scope` passthrough ─────────────────────────────────────────────

test('record_query (list mode) passes the scope filter through', async () => {
  const s = spy();
  const client = {
    records: {
      listRecords: async (args: unknown) => {
        s.record('listRecords', args);
        return { data: [], nextCursor: null };
      },
    },
  } as never;
  const tool = recordQuery({ client, log });
  await tool.handler({ type: 'memory', scope: 'org:6ba7b810' }, {});
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.scope, 'org:6ba7b810');
});

test('document_query (list mode) passes the scope filter through', async () => {
  const s = spy();
  const client = {
    documents: {
      listDocuments: async (args: unknown) => {
        s.record('listDocuments', args);
        return { data: [], nextCursor: null };
      },
    },
  } as never;
  const tool = documentQuery({ client, log });
  await tool.handler({ scope: 'group:eng-team' }, {});
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.scope, 'group:eng-team');
});

test('hybrid_search passes the scope filter through', async () => {
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
  await tool.handler({ query: 'q', scope: 'org:6ba7b810' }, {});
  const a = s.calls[0].args as Record<string, unknown>;
  assert.equal(a.scope, 'org:6ba7b810');
});

async function* ragStream() {
  yield { event: 'search_results' as const, hits: [{ id: 'd1' }] };
  yield { event: 'content_delta' as const, delta: 'Hi.' };
  yield { event: 'done' as const, inputTokens: 10, outputTokens: 2, model: 'claude-haiku-4-5' };
}

test('rag_ask passes the retrieval scope filter through', async () => {
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
  const r = await tool.handler({ query: 'q', search: { scope: 'org:6ba7b810' } }, {});
  assert.ok(!r.isError);
  const search = (s.calls[0].args as { search: Record<string, unknown> }).search;
  assert.equal(search.scope, 'org:6ba7b810');
});

// ── declaration guard ────────────────────────────────────────────────────────
// The passthrough tests above call `tool.handler(...)` DIRECTLY, which bypasses
// the input schema entirely — so a refactor that dropped `scope`/`scopes` from a
// tool's `inputSchema` (while leaving the handler passthrough) would keep them
// green even though an MCP client could no longer PASS the param. On a public
// surface an undeclared-but-honored param is unreachable (the #106 class). Pin
// the DECLARATION itself.
test('every scope-bearing tool DECLARES its scope/scopes param in inputSchema (client reachability)', () => {
  const deps = { client: {} as never, log };
  for (const [name, tool] of [
    ['record_create', recordCreate(deps)],
    ['document_ingest', documentIngest(deps)],
    ['folder_create', folderCreate(deps)],
  ] as const) {
    assert.ok('scopes' in tool.inputSchema, `${name} must DECLARE the \`scopes\` param in inputSchema`);
  }
  for (const [name, tool] of [
    ['record_query', recordQuery(deps)],
    ['document_query', documentQuery(deps)],
    ['hybrid_search', hybridSearch(deps)],
  ] as const) {
    assert.ok('scope' in tool.inputSchema, `${name} must DECLARE the \`scope\` filter in inputSchema`);
  }
  // rag_ask nests the filter under an optional `search` object — unwrap and pin it.
  const ragSearch = ragAsk(deps).inputSchema.search as {
    unwrap?: () => { shape: Record<string, unknown> };
    shape?: Record<string, unknown>;
  };
  const searchShape = ragSearch.unwrap?.().shape ?? ragSearch.shape;
  assert.ok(searchShape && 'scope' in searchShape, 'rag_ask must DECLARE `search.scope` in inputSchema');
});
