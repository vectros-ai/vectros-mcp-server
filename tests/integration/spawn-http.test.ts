/**
 * Spawn-http integration test — spawn the compiled cli-http.js as a
 * subprocess and verify the HTTP server starts up and serves the
 * healthz endpoint.
 *
 * The bearer-token gate + MCP protocol routing are exercised by
 * tests/unit/http-transport.test.ts directly against startHttpTransport.
 * This test only verifies the CLI binary wiring works end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

const CLI_HTTP_PATH = resolve(__dirname, '../../dist/cli-http.js');

/**
 * Ask the OS for a free TCP port: bind to :0 on loopback, read the assigned
 * port, release it. The CLI validates 1..65535 and won't accept :0 itself, so
 * we resolve a concrete free port here and pass it in. Replaces the old
 * `17654 + process.pid % 1000` heuristic, which collided whenever two runners
 * shared `pid % 1000` (the documented flake). The bind→close→reuse window is
 * the standard, negligible ephemeral-port race.
 */
function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/** Spawn cli-http with the given env overrides; return the child + a stderr accumulator. */
function spawnHttp(env: Record<string, string>) {
  const child = spawn('node', [CLI_HTTP_PATH], {
    env: {
      ...process.env,
      VECTROS_API_KEY: 'ssk_test_http_spawn',
      VECTROS_API_BASE_URL: 'https://api.staging.vectros.ai',
      VECTROS_MCP_SKIP_PING_VALIDATION: '1',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));
  child.stdout.on('data', () => {});
  return { child, getStderr: () => stderr };
}

test('cli-http REFUSES to bind a non-loopback host with no bearer token (exit 1)', async () => {
  // The load-bearing fail-closed: binding 0.0.0.0 with no bearer + no opt-out is
  // an open credential proxy. shouldRefuseInsecureBind is unit-tested as a
  // predicate; this proves the wiring at cli-http.ts actually exits the process.
  const port = await getFreePort();
  const { child, getStderr } = spawnHttp({
    VECTROS_MCP_HTTP_HOST: '0.0.0.0',
    VECTROS_MCP_HTTP_PORT: String(port),
    VECTROS_MCP_HTTP_BEARER_TOKEN: '', // explicitly none
    VECTROS_MCP_HTTP_ALLOW_INSECURE: '', // no opt-out
  });
  const code: number = await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(-1);
    }, 5000);
    child.once('exit', (c) => {
      clearTimeout(t);
      resolve(c ?? -1);
    });
  });
  assert.equal(code, 1, `expected exit 1 (refuse-to-bind), got ${code}; stderr: ${getStderr()}`);
  assert.match(getStderr(), /refusing to bind/i);
});

test('cli-http WITH a bearer token starts on a non-loopback host (healthz 200)', async () => {
  // The rescue case: the same non-loopback bind is allowed once a bearer token
  // is set. healthz is unauthenticated (probe-friendly), so it answers 200.
  const port = await getFreePort();
  const { child, getStderr } = spawnHttp({
    VECTROS_MCP_HTTP_HOST: '0.0.0.0',
    VECTROS_MCP_HTTP_PORT: String(port),
    VECTROS_MCP_HTTP_BEARER_TOKEN: 'a-real-bearer-token',
  });
  try {
    const deadline = Date.now() + 5000;
    let ok = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (r.status === 200) {
          ok = true;
          break;
        }
      } catch {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
    assert.ok(ok, `bearer-rescued non-loopback bind should serve healthz; stderr: ${getStderr()}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
});

test('spawn cli-http binary serves /healthz', async () => {
  const port = await getFreePort();

  const child = spawn('node', [CLI_HTTP_PATH], {
    env: {
      ...process.env,
      VECTROS_API_KEY: 'ssk_test_http_spawn',
      VECTROS_API_BASE_URL: 'https://api.staging.vectros.ai',
      VECTROS_MCP_HTTP_PORT: String(port),
      VECTROS_MCP_HTTP_HOST: '127.0.0.1',
      // Fake key would 401 ping — skip.
      VECTROS_MCP_SKIP_PING_VALIDATION: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Drain streams so the child doesn't block.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  try {
    // Wait for listening — poll healthz until we get a 200 (max 5s).
    const deadline = Date.now() + 5000;
    let lastErr: unknown;
    let ok = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (r.status === 200) {
          const body = (await r.json()) as Record<string, unknown>;
          assert.equal(body.status, 'ok');
          assert.equal(body.service, 'vectros-mcp-server');
          ok = true;
          break;
        }
      } catch (e) {
        lastErr = e;
        // Server not up yet — short wait + retry.
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
    assert.ok(ok, `healthz never responded: ${String(lastErr)}`);
  } finally {
    child.kill('SIGTERM');
    // Wait briefly for shutdown — don't leave a zombie.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
});
