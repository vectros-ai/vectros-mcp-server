/**
 * Streamable HTTP transport (v0.2+).
 *
 * Wraps the MCP SDK's `StreamableHTTPServerTransport` in a Node
 * `http.Server` that routes `POST /mcp` + `GET /mcp` to the
 * SDK's request handler.
 *
 * **v0.2 single-tenant model:** the MCP server uses the env
 * `VECTROS_API_KEY` for all upstream Vectros calls — the
 * Authorization header on incoming HTTP requests is NOT mapped to
 * an upstream credential (that's a v1.0+ multi-tenant feature). The
 * optional `bearerToken` opt provides client-to-server auth: if set,
 * incoming requests must present `Authorization: Bearer <token>`
 * matching exactly, or they get a 401. Recommended for any
 * deployment beyond localhost.
 *
 * **Stateful sessions:** the SDK generates a session ID per
 * initialization (uses `crypto.randomUUID()`). Session ID flows back
 * to the client in response headers; subsequent requests carry it
 * in `mcp-session-id` header. Session state is in-memory.
 *
 * Health check: `GET /` returns 200 with a simple JSON body. Useful
 * for k8s readiness probes, ALB target groups, etc.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from '../log.js';
import type { VectrosMCPServer } from '../server.js';

export interface HttpTransportOptions {
  /** Port to listen on. Default 8765. */
  port?: number;
  /** Host to bind to. Default 127.0.0.1 (localhost-only). Pass '0.0.0.0' for all interfaces. */
  host?: string;
  /**
   * Optional client→server bearer token. If set, incoming HTTP
   * requests must present `Authorization: Bearer <token>` matching
   * EXACTLY (constant-time-compare under the hood); else 401.
   * Strongly recommended for any deployment beyond localhost.
   */
  bearerToken?: string;
  /**
   * Extra allowed `Host` header values (in addition to the bind
   * host:port + localhost aliases that are always allowed). Used for
   * DNS-rebinding protection — a request whose Host is not in the
   * allow-list is rejected with 403. Reverse-proxy deployments set
   * this to the public hostname(s). See {@link VECTROS_MCP_HTTP_ALLOWED_HOSTS}.
   */
  allowedHosts?: string[];
  /**
   * Extra allowed `Origin` header values (in addition to the
   * http(s) origins of the allowed hosts). A request that PRESENTS an
   * Origin not in the allow-list is rejected with 403; a request with
   * NO Origin (non-browser MCP clients) is allowed. See
   * {@link VECTROS_MCP_HTTP_ALLOWED_ORIGINS}.
   */
  allowedOrigins?: string[];
  /** MCP server instance to handle requests. */
  mcpServer: VectrosMCPServer;
  /** Logger; defaults to a no-op if missing. */
  log: Logger;
}

export interface HttpTransportHandle {
  /** Address the server is bound to. */
  address: { host: string; port: number };
  /** Stops the server. Idempotent. */
  close: () => Promise<void>;
}

/** Constant-time string compare. Avoids timing-attack on the bearer-token check. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** True if `host` is a loopback bind address (no network exposure). */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/**
 * Whether to refuse starting the HTTP transport: a non-loopback bind with no
 * bearer token is an open credential proxy on the network. An explicit opt-out
 * (`VECTROS_MCP_HTTP_ALLOW_INSECURE=1`) overrides. Pure — unit-tested.
 */
export function shouldRefuseInsecureBind(host: string, hasBearer: boolean, allowInsecure: boolean): boolean {
  return !isLoopbackBindHost(host) && !hasBearer && !allowInsecure;
}

/** localhost / 127.0.0.1 / ::1 aliases for a given host (DNS-rebinding allow-list). */
function loopbackAliases(host: string): string[] {
  const h = host.toLowerCase();
  if (h === '127.0.0.1' || h === 'localhost') return ['127.0.0.1', 'localhost'];
  if (h === '::1' || h === '[::1]') return ['::1', '[::1]'];
  return [h];
}

/**
 * Build the set of allowed `Host` header values from the bind host + port,
 * plus any operator-configured extras. Includes both `host` and `host:port`
 * forms (clients may omit the port for a default-port deployment) and the
 * loopback aliases so `localhost` ↔ `127.0.0.1` both work.
 */
function buildAllowedHosts(host: string, port: number, extra: string[] = []): Set<string> {
  const set = new Set<string>();
  // Always allow loopback Host values (a rebound browser sends the attacker
  // DOMAIN as Host, never the loopback literal), plus the bind host:port. This
  // lets a `localhost` client reach a `0.0.0.0` bind without extra config.
  const hosts = [...loopbackAliases(host), '127.0.0.1', 'localhost', '::1', '[::1]'];
  for (const h of hosts) {
    set.add(h.toLowerCase());
    set.add(`${h.toLowerCase()}:${port}`);
  }
  for (const e of extra) set.add(e.trim().toLowerCase());
  return set;
}

/** Build the allowed `Origin` values: http(s) origins of every allowed host + extras. */
function buildAllowedOrigins(allowedHosts: Set<string>, extra: string[] = []): Set<string> {
  const set = new Set<string>();
  for (const h of allowedHosts) {
    set.add(`http://${h}`);
    set.add(`https://${h}`);
  }
  for (const e of extra) set.add(e.trim().toLowerCase().replace(/\/$/, ''));
  return set;
}

/**
 * DNS-rebinding / cross-origin guard. The MCP SDK's transport-level
 * `enableDnsRebindingProtection` flags are `@deprecated` in favour of
 * external middleware (this), so we validate Host + Origin ourselves:
 *   - `Host` must be in the allow-list (a rebound browser sends the attacker
 *     domain as Host → rejected even though it connected to the loopback IP);
 *   - if `Origin` is PRESENT it must be in the allow-list (blocks a malicious
 *     web page driving the local server cross-origin); a request with NO
 *     Origin (the normal non-browser MCP client) is allowed.
 *
 * Returns null when ok, or a short rejection reason.
 */
function checkHostAndOrigin(
  req: IncomingMessage,
  allowedHosts: Set<string>,
  allowedOrigins: Set<string>,
): string | null {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!host || !allowedHosts.has(host)) {
    return `disallowed Host header "${req.headers.host ?? ''}"`;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== '' && !allowedOrigins.has(origin.toLowerCase().replace(/\/$/, ''))) {
    return `disallowed Origin header "${origin}"`;
  }
  return null;
}

/** Comma-split a header/env list into trimmed non-empty values. */
function splitList(value: string[] | undefined): string[] {
  return (value ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
}

/**
 * Construct + start an HTTP server bound to the MCP server. Resolves
 * when the socket is listening (after `server.listen` 'listening'
 * event fires).
 */
export async function startHttpTransport(opts: HttpTransportOptions): Promise<HttpTransportHandle> {
  const port = opts.port ?? 8765;
  const host = opts.host ?? '127.0.0.1';
  const { mcpServer, log, bearerToken } = opts;

  // DNS-rebinding / cross-origin allow-lists. Populated after listen() so the
  // OS-assigned port (port: 0) is reflected; the handler closure reads them
  // and no request can arrive before listen resolves.
  let allowedHosts = new Set<string>();
  let allowedOrigins = new Set<string>();

  // Create the MCP transport (stateful — session ID per initialization).
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // Wire the MCP server to this transport.
  await mcpServer.connect(mcpTransport);

  const httpServer: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check — unauthenticated, separate from /mcp. Exempt from the
    // Host/Origin check too: probes (ALB/k8s) legitimately send arbitrary Host.
    if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'vectros-mcp-server' }));
      return;
    }

    // DNS-rebinding / cross-origin guard — BEFORE auth, so a rebound browser
    // page can't even reach the bearer check.
    const rebindReason = checkHostAndOrigin(req, allowedHosts, allowedOrigins);
    if (rebindReason) {
      log.warn(
        { url: req.url, ip: req.socket.remoteAddress, host: req.headers.host, origin: req.headers.origin },
        `HTTP request rejected: ${rebindReason}`,
      );
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden', reason: 'host_or_origin_not_allowed' }));
      return;
    }

    // Client→server bearer token check (if configured).
    if (bearerToken) {
      const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!provided || !constantTimeEqual(provided, bearerToken)) {
        log.warn({ url: req.url, ip: req.socket.remoteAddress }, 'HTTP request rejected: bad bearer token');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    // Route /mcp to the SDK transport. Other paths → 404.
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?') || req.url?.startsWith('/mcp/')) {
      try {
        await mcpTransport.handleRequest(req, res);
      } catch (err) {
        log.error({ err: String(err), url: req.url }, 'HTTP request handler failed');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', hint: 'MCP endpoint is at /mcp' }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const resolvedPort = typeof addr === 'object' && addr ? addr.port : port;

  // Now that the port is known, build the DNS-rebinding allow-lists. The
  // handler closure reads these; requests can only arrive after listen above.
  allowedHosts = buildAllowedHosts(host, resolvedPort, splitList(opts.allowedHosts));
  allowedOrigins = buildAllowedOrigins(allowedHosts, splitList(opts.allowedOrigins));

  log.info(
    {
      transport: 'StreamableHTTP',
      host,
      port: resolvedPort,
      bearerToken: bearerToken ? 'set' : 'none',
      allowedHosts: [...allowedHosts],
    },
    `MCP server listening on http://${host}:${resolvedPort}/mcp`,
  );

  if (!bearerToken) {
    log.warn(
      'HTTP transport started WITHOUT bearer token — anyone who can reach this port can call Vectros with your credentials. ' +
        'Set VECTROS_MCP_HTTP_BEARER_TOKEN (or the bearerToken constructor opt) for any non-localhost deployment.',
    );
  }

  return {
    address: { host, port: resolvedPort },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
