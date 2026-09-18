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
import { spawn } from 'node:child_process';
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
        // 0.41.0 SDK adoption
        'record_batch_get',
        'record_batch_write',
      ].sort(),
    );

    for (const t of tools.tools ?? []) {
      assert.ok(t.description && t.description.length > 20, `${t.name} has substantive description`);
      assert.ok(t.inputSchema, `${t.name} has inputSchema`);
    }

    // Tool annotations (readOnlyHint/destructiveHint/idempotentHint) must reach the
    // REAL tools/list response over the wire — a host reads THIS, not src/tools/*.ts.
    // Verifies the wiring in server.ts, not just that each factory sets the field.
    const byName = new Map((tools.tools ?? []).map((t) => [t.name, t]));
    for (const t of tools.tools ?? []) {
      assert.ok(t.annotations, `${t.name} has annotations`);
      assert.equal(typeof t.annotations!.readOnlyHint, 'boolean', `${t.name}: readOnlyHint is a boolean`);
      assert.equal(typeof t.annotations!.destructiveHint, 'boolean', `${t.name}: destructiveHint is a boolean`);
      assert.equal(typeof t.annotations!.idempotentHint, 'boolean', `${t.name}: idempotentHint is a boolean`);
    }
    // Spot-check the two ends of the spectrum, so a wrong hint (not just a missing
    // one) would fail this test — "annotate honestly" per the issue this closes.
    assert.deepEqual(
      byName.get('record_get')!.annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      'record_get: a pure read must never be flagged destructive',
    );
    assert.deepEqual(
      byName.get('record_delete')!.annotations,
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      'record_delete: a real delete must never be flagged read-only',
    );
    // Broader, cheap check for the rest of the fleet: every `*_delete` tool, by name,
    // is unambiguously destructive — a name-substring rule with zero exceptions in
    // the current 23-tool set. This closes part of the gap the other two exact-shape
    // spot-checks leave (they only cover 2 of 23; a copy-paste error on any of the
    // other 21 would otherwise pass this suite silently).
    for (const t of tools.tools ?? []) {
      if (t.name.endsWith('_delete')) {
        assert.equal(t.annotations!.readOnlyHint, false, `${t.name}: a delete tool must never be read-only`);
        assert.equal(t.annotations!.destructiveHint, true, `${t.name}: a delete tool must always be destructive`);
      }
    }
    // The `_delete` name-substring rule above only pins ONE direction (destructive tools
    // must not be read-only) for ONE naming pattern. Nothing previously pinned the
    // OPPOSITE direction — a true read must actually BE `readOnlyHint:true` — nor covered
    // the non-`*_delete` write tools at all: flipping `record_create` (or any of the other
    // five) to `readOnlyHint:true` would have passed this suite silently before this
    // addition. Two explicit, named lists close both gaps — a copy-paste or one-line
    // annotation error on any tool in either list now fails this test by name, not just
    // the `*_delete` subset. (`folder_create` sits in the write list, not the idempotent
    // "safe create" bucket its name suggests — see its own annotation comment for why:
    // its default no-`slug` path is NOT idempotent — a defect this suite's own prior
    // version failed to catch.)
    const READ_TOOLS = [
      'hybrid_search',
      'record_query',
      'record_batch_get',
      'list_schemas',
      'document_get',
      'document_query',
      'folder_query',
      'current_identity',
      'lookup_principal',
      'version_history',
    ];
    for (const name of READ_TOOLS) {
      const t = byName.get(name);
      assert.ok(t, `${name}: tool exists in tools/list`);
      assert.equal(t!.annotations!.readOnlyHint, true, `${name}: a true read must be readOnlyHint:true`);
      assert.equal(t!.annotations!.destructiveHint, false, `${name}: a true read must never be destructive`);
    }
    // `record_create`/`document_ingest`/`record_batch_write`/`folder_create` (optional dedupe
    // key), `record_update`/`document_update`/`folder_update` (JSON Merge Patch), and
    // `rag_ask`/`document_ask` (real-money inference calls — never read-only, regardless of
    // their destructiveHint) all mutate state or move money and must never be readOnlyHint:true.
    const WRITE_TOOLS = [
      'record_create',
      'document_ingest',
      'record_batch_write',
      'folder_create',
      'record_update',
      'document_update',
      'folder_update',
      'rag_ask',
      'document_ask',
    ];
    for (const name of WRITE_TOOLS) {
      const t = byName.get(name);
      assert.ok(t, `${name}: tool exists in tools/list`);
      assert.equal(t!.annotations!.readOnlyHint, false, `${name}: must never be flagged read-only`);
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

    // An out-of-range `limit` fails zod BEFORE any SDK call. The 'Invalid arguments'
    // message (not a network error against the fake key) proves the
    // request→validate→reject path short-circuits the dispatch.
    // (This used to pass `{}`, which stopped being schema-invalid in 0.17.0 when
    // `type` became optional so list mode could select by `folderId`/`recent`. The
    // branch under test is zod rejection, so it needs an argument zod still rejects.)
    const badArgs = await client.callTool({ name: 'record_query', arguments: { type: 'control', limit: 999 } });
    assert.equal(badArgs.isError, true, 'invalid args → isError');
    assert.match(JSON.stringify(badArgs.content), /Invalid arguments/);

    // The mode-selection guard is the OTHER fail-closed path — schema-valid, but no
    // list mode chosen. It must also refuse without reaching the SDK rather than
    // defaulting to some arbitrary listing.
    const noMode = await client.callTool({ name: 'record_query', arguments: {} });
    assert.equal(noMode.isError, true, 'no mode selector → isError');
    assert.match(JSON.stringify(noMode.content), /folderId/);
    assert.match(JSON.stringify(noMode.content), /recent/);

    // The highest-severity cold-agent trap found in review: an INVENTED top-level arg
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

test('CLI fails fast when no key resolves — asserts the actual exit code (1)', async () => {
  // The existing "CLI fails fast when no key resolves" test above only
  // regexes the MCP client's rejection reason, which passes identically
  // whether the process exits 1 as intended or corrupts to exit 127 via the
  // same libuv race the sibling test below fixes for the connect() path —
  // resolveApiKey() itself awaits an execFile() spawn on this exact path
  // (the "no env key, fall back to the keyring helper" branch), immediately
  // followed by this file's own process.exitCode assignment. A raw spawn +
  // explicit exit-code assertion is the only way this class of regression
  // would actually be caught.
  const child = spawn('node', [CLI_PATH], {
    env: {
      ...process.env,
      VECTROS_API_KEY: '',
      VECTROS_KEYRING_ALIAS: 'no-such-alias-integration-test',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));
  const code: number | null = await new Promise((res) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      res(null);
    }, 8000);
    child.once('exit', (c) => {
      clearTimeout(t);
      res(c);
    });
  });
  assert.equal(code, 1, `expected exit 1 (no usable key), got ${code}; stderr: ${stderr}`);
});

test('CLI exits 2 (not hangs) when startup ping validation fails (sibling of the CLI exit-race fix)', async () => {
  // connect() awaits a GET /v1/ping when validateOnStart is true (the
  // default) — the exact "await a fetch, then fail" shape that raced libuv on
  // Windows and corrupted the exit code in @vectros-ai/cli. Fixed the
  // same way here (process.exitCode instead of process.exit()). A raw spawn +
  // timeout, not the MCP client, because this must prove the process
  // actually TERMINATES: an MCP-client-based test (which just waits for a
  // handshake that will never come either way) can't distinguish "exited
  // with the right code" from "hung forever" the way this can.
  const child = spawn('node', [CLI_PATH], {
    env: {
      ...process.env,
      // Real prefix, fake suffix — see resolve-key.ts: no local length/format
      // check, so this reaches the real /v1/ping call and gets a genuine 403.
      // Keep the suffix under 28 chars: pipelines/public_mirror_scrub.sh's
      // secret pattern is `(sk|ssk)_(live|test)_[A-Za-z0-9_-]{28,}` — a
      // longer, more verbose "obviously fake" suffix here previously tripped
      // the publish-stage scrub as a false positive on a public-mirrored
      // package. Fix the fixture, not the scrub pattern or the allowlist —
      // this is code we can change, not vetted third-party content.
      VECTROS_API_KEY: 'ssk_live_not-a-real-key',
      VECTROS_API_BASE_URL: 'https://api.staging.vectros.ai',
      VECTROS_MCP_SKIP_PING_VALIDATION: '', // must NOT skip — this is what we're testing
      VECTROS_MCP_DEBUG: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));
  const code: number | null = await new Promise((res) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      res(null);
    }, 8000);
    child.once('exit', (c) => {
      clearTimeout(t);
      res(c);
    });
  });
  assert.equal(code, 2, `expected exit 2 (ping validation failure), got ${code}; stderr: ${stderr}`);
});
