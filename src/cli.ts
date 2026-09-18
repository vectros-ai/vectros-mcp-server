#!/usr/bin/env node
/**
 * CLI entry — `npx -y @vectros-ai/mcp-server` or
 * `vectros-mcp-server`. Reads env vars, spawns the server over
 * stdio, runs until the client disconnects.
 *
 * Env vars (see the design doc § "Configuration"):
 *   VECTROS_API_KEY                  the ssk_live_... key to run with. Optional
 *                                    ONLY when the vectros CLI is installed: if
 *                                    unset, the key is resolved from the CLI
 *                                    keyring (see resolve-key.ts). Set, it wins.
 *   VECTROS_KEYRING_ALIAS            optional; resolve this keyring entry rather
 *                                    than the active one (ignored when
 *                                    VECTROS_API_KEY is set)
 *   VECTROS_API_BASE_URL             optional; default https://api.vectros.ai
 *   VECTROS_MCP_TOOLS                optional; comma-separated tool names
 *                                    (default: all shipped tools enabled)
 *   VECTROS_MCP_DEBUG                optional; "1" enables debug logging
 *   VECTROS_MCP_SKIP_PING_VALIDATION optional; "1" or "true" disables the
 *                                    startup /v1/ping check (default: on)
 *
 * Exit codes:
 *   0   clean shutdown (client disconnected)
 *   1   fatal startup error (bad creds, bad config)
 *   2   uncaught runtime error
 *
 * Note: this file's main() runs unconditionally on import. To
 * unit-test arg-parsing without spawning the server, import the
 * helpers from `parse-tools-env.ts` directly. See
 * tests/unit/cli-env.test.ts for the canonical example.
 */
import { VectrosMCPServer } from './server.js';
import { createStdioTransport } from './transport/stdio.js';
import { createLogger } from './log.js';
import type { ToolName } from './tools/index.js';
import { InvalidApiKeyError } from './auth.js';
import { parseToolsEnv } from './parse-tools-env.js';
import { validateBaseUrl, InvalidBaseUrlError } from './base-url.js';
import { BUILD_INFO, formatBuildInfo } from './build-info.js';
import { resolveApiKey, noKeyMessage, keyringNotice } from './resolve-key.js';

async function main(): Promise<void> {
  // `--version` is the one safe stdout write: it prints + exits BEFORE the
  // stdio transport is created, so no MCP client is attached to stdout yet
  // (the stdout-purity rule applies to the running protocol, not a pre-start
  // CLI invocation). Reports the bundled SDK version (build-stamped).
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${formatBuildInfo()}\n`);
    process.exitCode = 0;
    return;
  }

  // Runtime-only. Provisioning (the `bootstrap` subcommand) moved to the
  // separate @vectros-ai/cli package (`npx -y @vectros-ai/cli bootstrap`) —
  // the credential-minting path is deliberately NOT shipped inside the
  // runtime a partner runs with their key.
  const log = createLogger();

  // Resolve the key from env, else the CLI keyring helper (one credential
  // source for the server, hooks, and scripts). Fail fast with actionable
  // guidance if neither yields a key — never log the secret itself.
  const resolved = await resolveApiKey();
  const apiKey = resolved.key;
  // Name the identity: an unset key resolves to whatever the keyring's ACTIVE
  // entry is, and "which alias is the live key?" is exactly the question users
  // get wrong. The alias is not a secret. Landing on an identity nobody named
  // warns (see keyringNotice).
  const notice = keyringNotice(resolved);
  if (notice) log[notice.level]({ alias: notice.alias }, notice.message);
  if (!apiKey) {
    log.fatal({ reason: resolved.reason }, noKeyMessage(resolved));
    process.exitCode = 1;
    return;
  }
  const apiBaseUrl = process.env.VECTROS_API_BASE_URL;

  // Validate any env-supplied base URL BEFORE the server attaches the API key.
  // An attacker-controlled VECTROS_API_BASE_URL would otherwise exfiltrate the
  // credential to its host via /v1/ping.
  if (apiBaseUrl !== undefined) {
    try {
      validateBaseUrl(apiBaseUrl, { warn: (m) => log.warn(m) });
    } catch (err) {
      if (err instanceof InvalidBaseUrlError) {
        log.fatal({ err: err.message }, 'invalid VECTROS_API_BASE_URL');
      } else {
        log.fatal({ err: String(err) }, 'invalid VECTROS_API_BASE_URL');
      }
      process.exitCode = 1;
      return;
    }
  }

  let tools: ToolName[] | undefined;
  try {
    tools = parseToolsEnv(process.env.VECTROS_MCP_TOOLS);
  } catch (err) {
    log.fatal({ err: String(err) }, 'invalid VECTROS_MCP_TOOLS');
    process.exitCode = 1;
    return;
  }

  // Startup ping validation defaults ON; explicit opt-out via env.
  const skipFlag = (process.env.VECTROS_MCP_SKIP_PING_VALIDATION ?? '').toLowerCase();
  const validateOnStart = !(skipFlag === '1' || skipFlag === 'true');

  let server: VectrosMCPServer;
  try {
    server = new VectrosMCPServer({
      apiKey,
      tools,
      apiBaseUrl,
      logger: log,
      validateOnStart,
    });
  } catch (err) {
    if (err instanceof InvalidApiKeyError) {
      log.fatal({ err: err.message }, 'startup failed: invalid API key');
    } else {
      log.fatal({ err: String(err) }, 'startup failed');
    }
    process.exitCode = 1;
    return;
  }

  const transport = createStdioTransport();

  // connect() performs a GET /v1/ping when validateOnStart is true (the
  // default), so a rejection here follows an await that can still be
  // settling a fetch/undici handle when process.exit() runs — the same
  // Windows libuv race that corrupts @vectros-ai/cli's exit code to 127.
  // Fixed the same way: process.exitCode instead of process.exit(), letting
  // the event loop drain naturally.
  //
  // ⚠️ OWNER-RULED DESIGN DECISION — do not "fix" this by moving the
  // SIGINT/SIGTERM registration below to before this block. That was tried
  // twice and reverted both times; read this before trying a third:
  //
  // The /v1/ping fetch this awaits (identity.ts) has NO timeout and NO
  // AbortController — it's an unbounded `await fetch(...)`. That rules out
  // the seemingly-obvious "register early, make shutdown() exitCode-safe
  // too" fix: shutdown()'s own process.exit(0) would then be reachable
  // WHILE this fetch is still in flight (a signal arriving mid-connect),
  // reintroducing the exact crash this file exists to fix, just via a
  // different call site. Converting shutdown()'s exit to exitCode instead
  // doesn't rescue it either — without an abort, the process would then
  // hang indefinitely waiting for a fetch that may never settle, trading a
  // crash for a silent hang on a truly stuck connection.
  //
  // The only ways to get a genuinely graceful shutdown DURING the connect
  // window are (a) thread an AbortController through connect() →
  // validateCredentials() → resolveIdentity() so a signal can cancel the
  // fetch before exiting, which is real scope growth (new signatures, new
  // wiring in both entry points, new tests) — or (b) accept that a signal
  // during this brief startup window gets Node's plain default disposition
  // (immediate termination, no graceful log) instead of shutdown()'s path.
  // (b) is the ruling: registering the listeners only AFTER a successful
  // connect(), below, means shutdown() can never run while this fetch is
  // outstanding — full stop, no exception, no abort machinery needed.
  try {
    await server.connect(transport);
    log.info(
      { version: BUILD_INFO.mcpServer, sdk: BUILD_INFO.sdk },
      'vectros-mcp-server listening on stdio',
    );
  } catch (err) {
    log.fatal({ err: String(err) }, 'failed to connect transport');
    process.exitCode = 2;
    return;
  }

  // Hook graceful shutdown — flush logs, close MCP, then exit. `process.exit()`
  // here is intentional and NOT part of the exit-code fix above: this fires
  // on an operator-initiated signal, not after a race-prone fetch (connect()
  // has already fully settled by the time these listeners exist — see the
  // comment above), and the server is by now a long-lived process whose
  // listeners (this pair included) must be force-stopped, not naturally
  // drained.
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown requested');
    try {
      await server.close();
    } catch (err) {
      log.warn({ err: String(err) }, 'error during server.close()');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Last-ditch fallback — anything not caught above.
  // Use stderr.write directly in case the logger isn't constructed yet.
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
