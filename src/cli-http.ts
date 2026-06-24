#!/usr/bin/env node
/**
 * HTTP CLI entry (v0.2+) — sibling to cli.ts. Starts the MCP server
 * with Streamable HTTP transport instead of stdio.
 *
 * Run as: `vectros-mcp-server-http` or `npx -y @vectros-ai/mcp-server vectros-mcp-server-http`.
 *
 * Env vars (additions to the stdio set — see cli.ts for the rest):
 *   VECTROS_MCP_HTTP_PORT             optional; default 8765
 *   VECTROS_MCP_HTTP_HOST             optional; default 127.0.0.1
 *                                     (localhost-only; pass 0.0.0.0
 *                                     for all interfaces)
 *   VECTROS_MCP_HTTP_BEARER_TOKEN     optional but STRONGLY RECOMMENDED
 *                                     for non-localhost deployments.
 *                                     Clients must present
 *                                     `Authorization: Bearer <token>`
 *                                     on every request. REQUIRED when
 *                                     binding a non-loopback host unless
 *                                     VECTROS_MCP_HTTP_ALLOW_INSECURE=1.
 *   VECTROS_MCP_HTTP_ALLOWED_HOSTS    optional; comma-separated extra Host
 *                                     header values to allow (DNS-rebinding
 *                                     protection). Set to the public
 *                                     hostname(s) behind a reverse proxy.
 *   VECTROS_MCP_HTTP_ALLOWED_ORIGINS  optional; comma-separated extra Origin
 *                                     header values to allow.
 *   VECTROS_MCP_HTTP_ALLOW_INSECURE   optional; "1" permits a non-loopback
 *                                     bind without a bearer token (NOT
 *                                     recommended).
 *
 * Exit codes (same as stdio CLI):
 *   0   clean shutdown
 *   1   fatal startup error
 *   2   uncaught runtime error
 *
 * Note: same three-file pattern as cli.ts — see CONVENTIONS §46.
 * main() runs unconditionally; helpers in parse-tools-env.ts are
 * unit-testable directly.
 */
import { VectrosMCPServer } from './server.js';
import { startHttpTransport, shouldRefuseInsecureBind } from './transport/http.js';
import { createLogger } from './log.js';
import type { ToolName } from './tools/index.js';
import { InvalidApiKeyError } from './auth.js';
import { parseToolsEnv } from './parse-tools-env.js';
import { validateBaseUrl, InvalidBaseUrlError } from './base-url.js';

async function main(): Promise<void> {
  const log = createLogger();

  const apiKey = process.env.VECTROS_API_KEY;
  const apiBaseUrl = process.env.VECTROS_API_BASE_URL;

  // Validate any env-supplied base URL BEFORE the server attaches the API key
  // (R1 F-06a) — see cli.ts for the credential-exfil rationale.
  if (apiBaseUrl !== undefined) {
    try {
      validateBaseUrl(apiBaseUrl, { warn: (m) => log.warn(m) });
    } catch (err) {
      const msg = err instanceof InvalidBaseUrlError ? err.message : String(err);
      log.fatal({ err: msg }, 'invalid VECTROS_API_BASE_URL');
      process.exit(1);
    }
  }

  const port = process.env.VECTROS_MCP_HTTP_PORT
    ? Number.parseInt(process.env.VECTROS_MCP_HTTP_PORT, 10)
    : undefined;
  const host = process.env.VECTROS_MCP_HTTP_HOST;
  const bearerToken = process.env.VECTROS_MCP_HTTP_BEARER_TOKEN || undefined;
  const allowedHosts = process.env.VECTROS_MCP_HTTP_ALLOWED_HOSTS
    ? [process.env.VECTROS_MCP_HTTP_ALLOWED_HOSTS]
    : undefined;
  const allowedOrigins = process.env.VECTROS_MCP_HTTP_ALLOWED_ORIGINS
    ? [process.env.VECTROS_MCP_HTTP_ALLOWED_ORIGINS]
    : undefined;

  if (port !== undefined && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    log.fatal({ port: process.env.VECTROS_MCP_HTTP_PORT }, 'invalid VECTROS_MCP_HTTP_PORT (must be 1-65535)');
    process.exit(1);
  }

  // Refuse to bind a non-loopback host without a bearer token: that is
  // an open credential proxy on the network. An explicit opt-out is required.
  const effectiveHost = host ?? '127.0.0.1';
  const allowInsecureHttp = ['1', 'true', 'yes'].includes(
    (process.env.VECTROS_MCP_HTTP_ALLOW_INSECURE ?? '').toLowerCase(),
  );
  if (shouldRefuseInsecureBind(effectiveHost, Boolean(bearerToken), allowInsecureHttp)) {
    log.fatal(
      { host: effectiveHost },
      'refusing to bind a non-loopback host without VECTROS_MCP_HTTP_BEARER_TOKEN — anyone who can ' +
        'reach this port could call Vectros with your credentials. Set a bearer token, or set ' +
        'VECTROS_MCP_HTTP_ALLOW_INSECURE=1 to override (NOT recommended).',
    );
    process.exit(1);
  }

  let tools: ToolName[] | undefined;
  try {
    tools = parseToolsEnv(process.env.VECTROS_MCP_TOOLS);
  } catch (err) {
    log.fatal({ err: String(err) }, 'invalid VECTROS_MCP_TOOLS');
    process.exit(1);
  }

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
      transport: 'http',
    });
  } catch (err) {
    if (err instanceof InvalidApiKeyError) {
      log.fatal({ err: err.message }, 'startup failed: invalid API key');
    } else {
      log.fatal({ err: String(err) }, 'startup failed');
    }
    process.exit(1);
  }

  let handle: Awaited<ReturnType<typeof startHttpTransport>>;
  try {
    handle = await startHttpTransport({
      mcpServer: server,
      log,
      port,
      host,
      bearerToken,
      allowedHosts,
      allowedOrigins,
    });
  } catch (err) {
    log.fatal({ err: String(err) }, 'failed to start HTTP transport');
    process.exit(2);
  }

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown requested');
    try {
      await handle.close();
      await server.close();
    } catch (err) {
      log.warn({ err: String(err) }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Stays alive until SIGINT/SIGTERM — the HTTP server keeps the
  // event loop busy via its listening socket.
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
