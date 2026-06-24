#!/usr/bin/env node
/**
 * CLI entry — `npx -y @vectros-ai/mcp-server` or
 * `vectros-mcp-server`. Reads env vars, spawns the server over
 * stdio, runs until the client disconnects.
 *
 * Env vars (see the design doc § "Configuration"):
 *   VECTROS_API_KEY                  required; ssk_live_... or similar
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

async function main(): Promise<void> {
  // `--version` is the one safe stdout write: it prints + exits BEFORE the
  // stdio transport is created, so no MCP client is attached to stdout yet
  // (the stdout-purity rule applies to the running protocol, not a pre-start
  // CLI invocation). Reports the bundled SDK version (build-stamped).
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${formatBuildInfo()}\n`);
    process.exit(0);
  }

  // Runtime-only. Provisioning (the `bootstrap` subcommand) moved to the
  // separate @vectros-ai/cli package (`npx -y @vectros-ai/cli bootstrap`) —
  // the credential-minting path is deliberately NOT shipped inside the
  // runtime a partner runs with their key.
  const log = createLogger();

  const apiKey = process.env.VECTROS_API_KEY;
  const apiBaseUrl = process.env.VECTROS_API_BASE_URL;

  // Validate any env-supplied base URL BEFORE the server attaches the API key
  // (R1 F-06a). An attacker-controlled VECTROS_API_BASE_URL would otherwise
  // exfiltrate the credential to its host via /v1/ping.
  if (apiBaseUrl !== undefined) {
    try {
      validateBaseUrl(apiBaseUrl, { warn: (m) => log.warn(m) });
    } catch (err) {
      if (err instanceof InvalidBaseUrlError) {
        log.fatal({ err: err.message }, 'invalid VECTROS_API_BASE_URL');
      } else {
        log.fatal({ err: String(err) }, 'invalid VECTROS_API_BASE_URL');
      }
      process.exit(1);
    }
  }

  let tools: ToolName[] | undefined;
  try {
    tools = parseToolsEnv(process.env.VECTROS_MCP_TOOLS);
  } catch (err) {
    log.fatal({ err: String(err) }, 'invalid VECTROS_MCP_TOOLS');
    process.exit(1);
  }

  // Startup ping validation defaults ON; explicit opt-out via env.
  const skipFlag = (process.env.VECTROS_MCP_SKIP_PING_VALIDATION ?? '').toLowerCase();
  const validateOnStart = !(skipFlag === '1' || skipFlag === 'true');

  let server: VectrosMCPServer;
  try {
    server = new VectrosMCPServer({
      apiKey: apiKey as string,
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
    process.exit(1);
  }

  const transport = createStdioTransport();

  // Hook graceful shutdown — flush logs, close MCP, then exit.
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

  try {
    await server.connect(transport);
    log.info(
      { version: BUILD_INFO.mcpServer, sdk: BUILD_INFO.sdk },
      'vectros-mcp-server listening on stdio',
    );
  } catch (err) {
    log.fatal({ err: String(err) }, 'failed to connect transport');
    process.exit(2);
  }
}

main().catch((err) => {
  // Last-ditch fallback — anything not caught above.
  // Use stderr.write directly in case the logger isn't constructed yet.
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
