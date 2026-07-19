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

    // record_query requires a non-empty `type`; `{}` fails zod BEFORE any SDK call.
    // The 'Invalid arguments' message (not a network error against the fake key)
    // proves the request→validate→reject path short-circuits the dispatch.
    const badArgs = await client.callTool({ name: 'record_query', arguments: {} });
    assert.equal(badArgs.isError, true, 'invalid args → isError');
    assert.match(JSON.stringify(badArgs.content), /Invalid arguments/);

    // #543 finding 1 (the highest-severity cold-agent trap): an INVENTED top-level arg
    // must ERROR, not silently fall through to a default mode. Before strict validation,
    // `record_query {type, filter:{…}}` dropped `filter` and ran in list mode, returning
    // wrong-but-plausible results. Now it is rejected, naming the offending key + the
    // valid argument list so the agent self-corrects.
    const strayArg = await client.callTool({
      name: 'record_query',
      arguments: { type: 'control', filter: { externalId: 'x' } },
    });
    assert.equal(strayArg.isError, true, 'unknown arg → isError (no silent list-mode fallthrough)');
    assert.match(JSON.stringify(strayArg.content), /Unknown argument\(s\): filter/);
    assert.match(JSON.stringify(strayArg.content), /Valid arguments for record_query/);
  } finally {
    await client.close();
  }
});

test('CLI fails fast when no key resolves (no env key, no keyring match)', async () => {
  // An unset VECTROS_API_KEY no longer means "fail" — it means "fall back to the
  // CLI keyring helper". So pin an alias that cannot resolve, which is
  // deterministic on ANY machine: with the CLI installed the helper exits 2 (no
  // such entry), without it the helper reports the CLI absent. Both leave the
  // server with no key. Without this pin the test would depend on whether the
  // machine running it happens to have a readable active keyring entry.
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI_PATH],
    env: {
      ...process.env,
      VECTROS_API_KEY: '',
      VECTROS_KEYRING_ALIAS: 'no-such-alias-integration-test',
    },
  });
  const client = new Client({ name: 'integration-test', version: '0.0.1' }, { capabilities: {} });
  await assert.rejects(client.connect(transport), /process exited|spawn|connection|closed/i);
});
