/**
 * VectrosMCPServer construction-time behavior:
 *   - tools: [...] filter respected (subset vs all)
 *   - unknown tool name in filter → throws
 *   - bad API key → throws InvalidApiKeyError
 *   - registeredToolNames getter reflects what got registered
 *
 * We do NOT test handler invocation here — that's tools-handlers.test.
 * We do NOT test the JSON-RPC wiring — that's spawn-stdio.test.
 *
 * Note: construction also instantiates a real VectrosClient. The
 * client doesn't network on construction — first call triggers I/O
 * — so we can construct with fake keys safely.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { connect as netConnect } from 'node:net';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { VectrosMCPServer } from '../../src/server.js';
import { InvalidApiKeyError } from '../../src/auth.js';
import { InvalidBaseUrlError } from '../../src/base-url.js';

const silent = pino({ level: 'silent' });

test('construction with default tools registers every shipped tool', () => {
  // As v0.2 tools land they're added to ALL_TOOL_FACTORIES and become
  // part of the default registration. This list grows with each tool
  // implementation — that's intentional. The asserts below are the
  // contract for "what does no-args construction give you?"
  const s = new VectrosMCPServer({ apiKey: 'ssk_test_unit', logger: silent });
  assert.deepEqual(
    [...s.registeredToolNames].sort(),
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
});

test('tools: [...] filter registers ONLY the requested subset', () => {
  const s = new VectrosMCPServer({
    apiKey: 'ssk_test_unit',
    tools: ['hybrid_search', 'rag_ask'],
    logger: silent,
  });
  assert.deepEqual(
    [...s.registeredToolNames].sort(),
    ['hybrid_search', 'rag_ask'],
    'filter is load-bearing for least-privilege; must NOT silently register all',
  );
});

test('tools: [] (empty array) registers ZERO tools', () => {
  const s = new VectrosMCPServer({
    apiKey: 'ssk_test_unit',
    tools: [],
    logger: silent,
  });
  assert.deepEqual([...s.registeredToolNames], []);
});

test('tools: [unknown] throws with a useful message', () => {
  assert.throws(
    () =>
      new VectrosMCPServer({
        apiKey: 'ssk_test_unit',
        // Intentional wrong name to verify validation.
        tools: ['not_a_real_tool' as 'hybrid_search'],
        logger: silent,
      }),
    /Unknown tool names.*not_a_real_tool/,
  );
});

test('tools: [valid, invalid] throws and lists ALL invalid names', () => {
  assert.throws(
    () =>
      new VectrosMCPServer({
        apiKey: 'ssk_test_unit',
        tools: ['hybrid_search', 'nope_1' as 'hybrid_search', 'nope_2' as 'hybrid_search'],
        logger: silent,
      }),
    /nope_1.*nope_2/,
  );
});

test('missing apiKey throws InvalidApiKeyError', () => {
  assert.throws(
    () =>
      new VectrosMCPServer({
        // Intentionally invalid to verify fail-fast.
        apiKey: '' as string,
        logger: silent,
      }),
    InvalidApiKeyError,
  );
});

test('malformed apiKey throws InvalidApiKeyError', () => {
  assert.throws(
    () =>
      new VectrosMCPServer({
        apiKey: 'not-a-valid-key',
        logger: silent,
      }),
    InvalidApiKeyError,
  );
});

// ============================================================================
// Base-URL allow-list — the fail-closed credential-exfil guard runs DURING
// construction (a programmatic embedder reaches the constructor directly,
// bypassing the CLI's own validate). base-url.test.ts proves the predicate;
// these prove construction actually calls it and throws.
// ============================================================================

test('construction THROWS InvalidBaseUrlError on a non-Vectros impostor host', () => {
  assert.throws(
    () =>
      new VectrosMCPServer({
        apiKey: 'ssk_test_x',
        // Impostor host: a regression that constructed the client before validating
        // would leak the API key here via /v1/ping.
        apiBaseUrl: 'https://api.vectros.ai.evil.com',
        logger: silent,
        validateOnStart: false,
      }),
    InvalidBaseUrlError,
  );
});

test('construction ACCEPTS a loopback http base URL (local proxy / dev)', () => {
  const s = new VectrosMCPServer({
    apiKey: 'ssk_test_x',
    apiBaseUrl: 'http://127.0.0.1:1',
    logger: silent,
    validateOnStart: false,
  });
  assert.ok(s, 'loopback http URL is allowed at construction');
});

test('registeredToolNames preserves registration order', () => {
  // Registration order matters because tools/list returns tools in
  // that order — partners may rely on the ordering for UI display.
  const s = new VectrosMCPServer({
    apiKey: 'ssk_test_unit',
    tools: ['rag_ask', 'hybrid_search'],
    logger: silent,
  });
  // Whatever order the user passed in, the canonical registry order
  // (ALL_TOOL_FACTORIES Object.keys) is what the server uses.
  // Currently: hybrid_search, record_query, rag_ask, document_ask.
  // Filter preserves the registry order, NOT the user-passed order.
  // (Documented in src/tools/index.ts.)
  assert.deepEqual([...s.registeredToolNames], ['rag_ask', 'hybrid_search']);
});

// ============================================================================
// Resources (v0.2+)
// ============================================================================

test('construction with default resources registers all shipped resources', () => {
  const s = new VectrosMCPServer({ apiKey: 'ssk_test_unit', logger: silent });
  assert.deepEqual(
    [...s.registeredResourceNames].sort(),
    ['schemas', 'identity'].sort(),
  );
});

test('resources: [...] filter registers ONLY the requested subset', () => {
  const s = new VectrosMCPServer({
    apiKey: 'ssk_test_unit',
    resources: ['identity'],
    logger: silent,
  });
  assert.deepEqual([...s.registeredResourceNames], ['identity']);
});

test('resources: [] (empty array) registers ZERO resources', () => {
  // When resources=[], the server should NOT advertise the resources
  // capability — clients should see "no resources here" cleanly.
  const s = new VectrosMCPServer({
    apiKey: 'ssk_test_unit',
    resources: [],
    logger: silent,
  });
  assert.deepEqual([...s.registeredResourceNames], []);
});

test('resources: [unknown] throws with a useful message', () => {
  assert.throws(
    () =>
      new VectrosMCPServer({
        apiKey: 'ssk_test_unit',
        resources: ['not_a_real_resource' as 'schemas'],
        logger: silent,
      }),
    /Unknown resource names.*not_a_real_resource/,
  );
});

// ============================================================================
// Startup ping validation (v0.2+)
//
// connect() runs a /v1/ping check when validateOnStart=true (the
// default). On failure, the connect() promise rejects so the partner's
// MCP client surfaces a clear startup error instead of working until
// the first tool call.
// ============================================================================

/**
 * Spin up a localhost HTTP server that returns the given status for
 * GET /v1/ping. Returns the base URL and a close function.
 */
async function spawnPingServer(status: number, body = ''): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === '/v1/ping') {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  await once(server, 'listening');
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected address');
  // Probe to make sure the socket is reachable before the test runs.
  // (Mostly belt-and-suspenders — listen+'listening' is usually enough.)
  await new Promise<void>((resolve, reject) => {
    const sock = netConnect(addr.port, '127.0.0.1', () => {
      sock.end();
      resolve();
    });
    sock.once('error', reject);
  });
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Minimal no-op transport for testing connect() without I/O.
function makeFakeTransport() {
  return {
    async start() {},
    async close() {},
    async send() {},
    onmessage: () => {},
    onclose: () => {},
    onerror: () => {},
  };
}

test('validateOnStart=true (default): connect() throws on 401 ping', async () => {
  const { url, close } = await spawnPingServer(401, 'Unauthorized');
  try {
    const s = new VectrosMCPServer({
      apiKey: 'ssk_live_bad',
      apiBaseUrl: url,
      logger: silent,
      // validateOnStart defaults to true
    });
    await assert.rejects(
      s.connect(makeFakeTransport() as never),
      /401|HTTP/,
      'bad credential fails fast at connect()',
    );
  } finally {
    await close();
  }
});

test('validateOnStart=true: connect() succeeds on 200 ping', async () => {
  const { url, close } = await spawnPingServer(200, '');
  try {
    const s = new VectrosMCPServer({
      apiKey: 'ssk_live_good',
      apiBaseUrl: url,
      logger: silent,
    });
    // Should resolve cleanly — ping ok, transport wires up.
    await s.connect(makeFakeTransport() as never);
    await s.close();
  } finally {
    await close();
  }
});

test('validateOnStart=false: connect() skips ping entirely', async () => {
  // Point at a port that should be closed (effectively unreachable).
  // If validation ran, the connect would fail; with skip, it should
  // succeed because we never try to ping.
  const s = new VectrosMCPServer({
    apiKey: 'ssk_live_x',
    apiBaseUrl: 'http://127.0.0.1:1', // port 1 → connection refused
    logger: silent,
    validateOnStart: false,
  });
  // Should resolve — no ping attempted.
  await s.connect(makeFakeTransport() as never);
  await s.close();
});
