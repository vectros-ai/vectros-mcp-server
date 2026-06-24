/**
 * Structured logger — pino, always to stderr.
 *
 * CRITICAL: stdout is reserved for the MCP JSON-RPC stream when the
 * server runs over stdio transport. Anything written to stdout that
 * is not a valid JSON-RPC message corrupts the protocol and the
 * client disconnects.
 *
 * Every log line goes to stderr. There are no exceptions.
 */
import pino, { type Logger } from 'pino';

export interface LogContext {
  debug?: boolean;
}

/**
 * Build a stderr-destined logger.
 *
 * Pass `debug: true` (or set `VECTROS_MCP_DEBUG=1`) to lower the
 * level to `debug`. Default is `info`.
 */
export function createLogger(ctx: LogContext = {}): Logger {
  const debugEnabled = ctx.debug ?? process.env.VECTROS_MCP_DEBUG === '1';
  // pino.destination(2) — file descriptor 2 = stderr. NOT stdout.
  return pino(
    {
      level: debugEnabled ? 'debug' : 'info',
      base: { component: '@vectros-ai/mcp-server' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(2),
  );
}

export type { Logger };
