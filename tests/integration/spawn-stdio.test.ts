/**
 * Spawn-stdio integration test — spawn the compiled CLI as a
 * subprocess, talk MCP JSON-RPC over stdio, verify the handshake +
 * tool catalog are correct.
 *
 * This test mocks the SDK at the env-var level (uses a fake key);
 * no live API calls. The point is to verify the CLI wiring (env →
 * server construct → stdio transport → JSON-RPC) works end-to-end
 * without depending on staging.
 *
 * For live-API smoke (real RAG against staging), see the
 * dedicated smoke-test suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const CLI_PATH = resolve(__dirname, '../../dist/cli.js');

test('spawn stdio server + handshake + list_tools', async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH],
    env: {
      ...process.env,
      // Fake-but-well-formed key — the CLI accepts the shape; any
      // tools/call against the real SDK would fail with a network
      // error, but we don't make tools/call here.
      VECTROS_API_KEY: 'ssk_test_integration_test_fake',
      VECTROS_API_BASE_URL: 'https://api.staging.vectros.ai',
      // Skip startup ping — fake key would 401 against staging and
      // we're testing CLI wiring, not credential validation.
      VECTROS_MCP_SKIP_PING_VALIDATION: '1',
      // Suppress log noise during the test.
      VECTROS_MCP_DEBUG: '',
    },
  });

  const client = new Client({ name: 'integration-test', version: '0.0.1' }, { capabilities: {} });

  try {
    await client.connect(transport);

    // tools/list returns every shipped tool. This list grows as v0.2
    // tools land — keep in lockstep with src/tools/index.ts.
    const tools = await client.listTools();
    const names = (tools.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(
      names,
      [
        // v0.1
        'document_ask',
        'hybrid_search',
        'rag_ask',
        'record_query',
        // v0.2
        'list_schemas',
        'document_get',
        'current_identity',
        'document_ingest',
        // launch data-plane I/O (tier 1)
        'record_get',
        'record_create',
        'record_update',
        'record_delete',
        // launch data-plane I/O (tier 2)
        'document_query',
        // launch data-plane I/O (tier 3)
        'document_update',
        'document_delete',
        'folder_query',
        'folder_create',
        'folder_update',
        'folder_delete',
        // parity sweep
        'lookup_principal',
        'version_history',
      ].sort(),
    );

    for (const t of tools.tools ?? []) {
      assert.ok(t.description && t.description.length > 20, `${t.name} has substantive description`);
      assert.ok(t.inputSchema, `${t.name} has inputSchema`);
    }

    // resources/list returns the v0.2 resource catalog.
    const resources = await client.listResources();
    const resNames = (resources.resources ?? []).map((r) => r.name).sort();
    assert.deepEqual(resNames, ['identity', 'schemas']);
    for (const r of resources.resources ?? []) {
      assert.ok(r.uri.startsWith('vectros://'), `${r.name}: vectros:// URI`);
      assert.ok(r.description && r.description.length > 20, `${r.name}: substantive description`);
      assert.ok(r.mimeType, `${r.name}: mimeType`);
    }
  } finally {
    await client.close();
  }
});

test('tools/call dispatch fails closed: unknown tool + invalid args (no SDK call)', async () => {
  // server.ts:211 CallTool handler has two defensive branches that nothing else
  // exercises: unknown-tool → toolError('No such tool'), and a zod safeParse
  // failure → toolError('Invalid arguments'). Drive both through the real wired
  // JSON-RPC path via the MCP Client.
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH],
    env: {
      ...process.env,
      VECTROS_API_KEY: 'ssk_test_integration_test_fake',
      VECTROS_API_BASE_URL: 'https://api.staging.vectros.ai',
      VECTROS_MCP_SKIP_PING_VALIDATION: '1',
      VECTROS_MCP_DEBUG: '',
    },
  });
  const client = new Client({ name: 'integration-test', version: '0.0.1' }, { capabilities: {} });
  try {
    await client.connect(transport);

    const unknown = await client.callTool({ name: 'not_a_tool', arguments: {} });
    assert.equal(unknown.isError, true, 'unknown tool → isError');
    assert.match(JSON.stringify(unknown.content), /No such tool/);

    // record_get requires a non-empty `id`; `{}` fails zod BEFORE any SDK call.
    // The 'Invalid arguments' message (not a network error against the fake key)
    // proves the request→validate→reject path short-circuits the dispatch.
    const badArgs = await client.callTool({ name: 'record_get', arguments: {} });
    assert.equal(badArgs.isError, true, 'invalid args → isError');
    assert.match(JSON.stringify(badArgs.content), /Invalid arguments/);
  } finally {
    await client.close();
  }
});

test('CLI fails fast on missing VECTROS_API_KEY', async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH],
    env: { ...process.env, VECTROS_API_KEY: '' },
  });
  const client = new Client({ name: 'integration-test', version: '0.0.1' }, { capabilities: {} });
  await assert.rejects(client.connect(transport), /process exited|spawn|connection|closed/i);
});
