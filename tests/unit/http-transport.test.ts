/**
 * HTTP transport tests — exercise startHttpTransport with a fake
 * MCP server (we don't actually want to test the SDK's
 * StreamableHTTPServerTransport, only OUR wrapper logic: bearer
 * token gate, healthz endpoint, 404 routing, log signals).
 *
 * The actual /mcp request flow is exercised by the integration
 * test against the built dist/cli-http.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import pino from 'pino';

import { VectrosMCPServer } from '../../src/server.js';
import { startHttpTransport, isLoopbackBindHost, shouldRefuseInsecureBind } from '../../src/transport/http.js';

const silent = pino({ level: 'silent' });

/**
 * Raw HTTP POST to /mcp with caller-controlled Host/Origin headers — `fetch`
 * forbids setting the Host header, so the DNS-rebinding tests need node:http.
 */
function rawPost(
  port: number,
  headers: Record<string, string>,
  path = '/mcp',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  });
}

/** Make a fresh server with validateOnStart off (no real ping). */
function makeServer() {
  return new VectrosMCPServer({
    apiKey: 'ssk_test_http_unit',
    apiBaseUrl: 'http://127.0.0.1:1',
    logger: silent,
    validateOnStart: false,
    transport: 'http',
  });
}

test('HTTP transport starts on random port + closes cleanly', async () => {
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0, // OS assigns
  });
  assert.equal(handle.address.host, '127.0.0.1');
  assert.ok(handle.address.port > 0, 'OS-assigned port');
  await handle.close();
});

test('HTTP transport / and /healthz return 200', async () => {
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0,
  });
  try {
    const base = `http://${handle.address.host}:${handle.address.port}`;

    const r1 = await fetch(`${base}/`);
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as Record<string, unknown>;
    assert.equal(b1.status, 'ok');
    assert.equal(b1.service, 'vectros-mcp-server');

    const r2 = await fetch(`${base}/healthz`);
    assert.equal(r2.status, 200);
  } finally {
    await handle.close();
  }
});

test('HTTP transport returns 404 for unknown paths', async () => {
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0,
  });
  try {
    const r = await fetch(`http://${handle.address.host}:${handle.address.port}/random-path`);
    assert.equal(r.status, 404);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.error, 'not_found');
    assert.match(String(body.hint), /\/mcp/);
  } finally {
    await handle.close();
  }
});

test('HTTP transport with bearerToken rejects requests without Authorization (/mcp)', async () => {
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0,
    bearerToken: 'secret-token-xyz',
  });
  try {
    const r = await fetch(`http://${handle.address.host}:${handle.address.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(r.status, 401);
  } finally {
    await handle.close();
  }
});

test('HTTP transport with bearerToken rejects requests with wrong token', async () => {
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0,
    bearerToken: 'correct-token',
  });
  try {
    const r = await fetch(`http://${handle.address.host}:${handle.address.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(r.status, 401);
  } finally {
    await handle.close();
  }
});

test('HTTP transport with bearerToken: the CORRECT token gets PAST the gate (not 401)', async () => {
  // The reject paths above only prove the gate says "no". This proves the
  // accept half — constantTimeEqual must return true for a matching token, or a
  // bug that always-rejects (or an off-by-one length check) would lock out every
  // valid client while all the 401-expecting tests stayed green.
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0,
    bearerToken: 'correct-token',
  });
  try {
    const r = await rawPost(handle.address.port, {
      Host: `127.0.0.1:${handle.address.port}`,
      Authorization: 'Bearer correct-token',
    });
    assert.notEqual(r.status, 401, 'a valid bearer must pass the auth gate');
    // Case-insensitive scheme prefix must also work.
    const r2 = await rawPost(handle.address.port, {
      Host: `127.0.0.1:${handle.address.port}`,
      Authorization: 'bearer correct-token',
    });
    assert.notEqual(r2.status, 401, 'the "bearer " scheme prefix is case-insensitive');
  } finally {
    await handle.close();
  }
});

test('HTTP transport with bearerToken: healthz still accessible without auth', async () => {
  // Health checks must work for k8s readiness probes etc. — bearer
  // gate only applies to /mcp.
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0,
    bearerToken: 'secret',
  });
  try {
    const r = await fetch(`http://${handle.address.host}:${handle.address.port}/healthz`);
    assert.equal(r.status, 200, 'healthz must NOT require auth (probe-friendliness)');
  } finally {
    await handle.close();
  }
});

test('HTTP transport without bearerToken: anyone can call /mcp (warned in startup log)', async () => {
  // Note: we don't actually exercise an end-to-end MCP call here
  // (that's the integration test). We verify that the request gets
  // past the auth gate by checking we don't get a 401.
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0,
    // bearerToken: undefined
  });
  try {
    const r = await fetch(`http://${handle.address.host}:${handle.address.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    // Not 401 — gate is open. The SDK might 400/406/200 depending on
    // the request shape but anything other than 401 proves the gate
    // didn't reject us.
    assert.notEqual(r.status, 401, 'no-token mode must NOT reject');
  } finally {
    await handle.close();
  }
});

// ── Non-loopback bind classification (drives the require-bearer guard) ───────

test('isLoopbackBindHost classifies loopback vs network binds', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackBindHost(h), true, `${h} is loopback`);
  }
  for (const h of ['0.0.0.0', '::', '10.0.0.5', 'example.com']) {
    assert.equal(isLoopbackBindHost(h), false, `${h} is non-loopback`);
  }
});

test('shouldRefuseInsecureBind: only a non-loopback bind with no bearer + no opt-out refuses', () => {
  // Loopback never refuses, regardless of bearer/opt-out.
  assert.equal(shouldRefuseInsecureBind('127.0.0.1', false, false), false);
  assert.equal(shouldRefuseInsecureBind('localhost', false, false), false);
  // Non-loopback with no bearer + no opt-out → REFUSE.
  assert.equal(shouldRefuseInsecureBind('0.0.0.0', false, false), true);
  assert.equal(shouldRefuseInsecureBind('10.0.0.5', false, false), true);
  // Non-loopback rescued by a bearer token.
  assert.equal(shouldRefuseInsecureBind('0.0.0.0', true, false), false);
  // Non-loopback rescued by the explicit opt-out.
  assert.equal(shouldRefuseInsecureBind('0.0.0.0', false, true), false);
});

// ── DNS-rebinding / cross-origin guard ──────────────────────────────────────

test('rejects /mcp with a disallowed Host header (DNS-rebinding)', async () => {
  const handle = await startHttpTransport({ mcpServer: makeServer(), log: silent, port: 0 });
  try {
    // A rebound browser connects to the loopback IP but sends the attacker
    // domain as Host — must be 403 before any auth/processing.
    const r = await rawPost(handle.address.port, { Host: 'attacker.evil.com' });
    assert.equal(r.status, 403);
    assert.match(r.body, /host_or_origin_not_allowed/);
  } finally {
    await handle.close();
  }
});

test('rejects /mcp with a disallowed Origin header (cross-origin web page)', async () => {
  const handle = await startHttpTransport({ mcpServer: makeServer(), log: silent, port: 0 });
  try {
    const r = await rawPost(handle.address.port, {
      Host: `127.0.0.1:${handle.address.port}`,
      Origin: 'https://evil.example.com',
    });
    assert.equal(r.status, 403);
  } finally {
    await handle.close();
  }
});

test('allows /mcp with the loopback Host and NO Origin (non-browser MCP client)', async () => {
  const handle = await startHttpTransport({ mcpServer: makeServer(), log: silent, port: 0 });
  try {
    const r = await rawPost(handle.address.port, { Host: `127.0.0.1:${handle.address.port}` });
    // Past the rebinding gate — the SDK may 400/406/200, but NOT 403.
    assert.notEqual(r.status, 403, 'a legit no-Origin client must not be rebinding-rejected');
    assert.doesNotMatch(r.body, /host_or_origin_not_allowed/, 'must not carry the rebinding-rejection body');
  } finally {
    await handle.close();
  }
});

test('allows the localhost alias of a 127.0.0.1 bind', async () => {
  const handle = await startHttpTransport({ mcpServer: makeServer(), log: silent, port: 0 });
  try {
    const r = await rawPost(handle.address.port, { Host: `localhost:${handle.address.port}` });
    assert.notEqual(r.status, 403, 'localhost ↔ 127.0.0.1 must both be allowed');
    assert.doesNotMatch(r.body, /host_or_origin_not_allowed/, 'localhost Host must pass the rebinding gate');
  } finally {
    await handle.close();
  }
});

test('honors operator-configured extra allowedHosts + allowedOrigins', async () => {
  const handle = await startHttpTransport({
    mcpServer: makeServer(),
    log: silent,
    port: 0,
    allowedHosts: ['proxy.internal, mcp.example.com'], // comma-split supported
    allowedOrigins: ['https://app.example.com'],
  });
  try {
    const okHost = await rawPost(handle.address.port, { Host: 'mcp.example.com' });
    assert.notEqual(okHost.status, 403, 'configured extra host must be allowed');

    const okOrigin = await rawPost(handle.address.port, {
      Host: `127.0.0.1:${handle.address.port}`,
      Origin: 'https://app.example.com',
    });
    assert.notEqual(okOrigin.status, 403, 'configured extra origin must be allowed');
  } finally {
    await handle.close();
  }
});

test('health check is exempt from the Host check (probe-friendliness)', async () => {
  const handle = await startHttpTransport({ mcpServer: makeServer(), log: silent, port: 0 });
  try {
    // Probe with an arbitrary Host (e.g. an ALB DNS name) still gets 200.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: handle.address.port,
          path: '/healthz',
          method: 'GET',
          headers: { Host: 'lb.aws.internal' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200);
  } finally {
    await handle.close();
  }
});
