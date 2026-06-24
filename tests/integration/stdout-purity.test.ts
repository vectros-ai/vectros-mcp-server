/**
 * Stdout-purity test — the #1 footgun in MCP server land.
 *
 * The MCP stdio transport reserves stdout for newline-delimited
 * JSON-RPC messages. ANY stray write to stdout — a stray
 * console.log(), a pino misconfiguration, a transitive dep that
 * logs on import — corrupts the protocol. The MCP client sees
 * garbage on the stream and disconnects.
 *
 * This test spawns the built CLI directly (not through @mcp/sdk),
 * sends a JSON-RPC handshake + tools/list, collects every byte
 * written to stdout, and asserts that every non-empty newline-
 * delimited line parses as valid JSON (= valid JSON-RPC).
 *
 * If a future change introduces stdout pollution (even once), this
 * fails permanently — no allowlist, no exceptions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CLI_PATH = resolve(__dirname, '../../dist/cli.js');

test('every stdout line is valid JSON (no pollution)', async () => {
  const child = spawn('node', [CLI_PATH], {
    env: {
      ...process.env,
      VECTROS_API_KEY: 'ssk_test_stdout_purity',
      VECTROS_API_BASE_URL: 'https://api.staging.vectros.ai',
      // Fake key would 401 against staging — skip the startup ping
      // since we're testing stdout cleanliness, not auth.
      VECTROS_MCP_SKIP_PING_VALIDATION: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
  });

  // Drain stderr to avoid blocking — pino logs land there.
  child.stderr.on('data', () => {});

  // Send MCP initialize + tools/list. These are minimal but valid
  // JSON-RPC envelopes; the server's responses get captured above.
  const initReq = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdout-purity', version: '0.0.0' },
    },
  };
  const initNotif = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
  const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

  child.stdin.write(JSON.stringify(initReq) + '\n');
  child.stdin.write(JSON.stringify(initNotif) + '\n');
  child.stdin.write(JSON.stringify(listReq) + '\n');

  // Give the server time to respond to both requests.
  await delay(800);

  child.stdin.end();
  child.kill('SIGTERM');

  // Wait for stdio to flush.
  await new Promise<void>((res) => child.once('exit', () => res()));

  // Validate every non-empty newline-delimited line is valid JSON.
  const lines = stdoutBuf.split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length >= 2, `expected ≥2 JSON-RPC responses on stdout, got ${lines.length}`);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      assert.equal(parsed.jsonrpc, '2.0', `line missing jsonrpc=2.0: ${line.slice(0, 80)}`);
    } catch {
      assert.fail(
        `STDOUT POLLUTION DETECTED — line is not valid JSON-RPC:\n${line.slice(0, 200)}\n` +
          `Cause: somewhere in the server (or a dep it loads) wrote to stdout. ` +
          `Every log line MUST go to stderr; stdout is reserved for JSON-RPC.`,
      );
    }
  }
});
