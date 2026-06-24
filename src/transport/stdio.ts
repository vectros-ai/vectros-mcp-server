/**
 * Stdio transport wiring.
 *
 * Re-exports the MCP SDK's `StdioServerTransport` so consumers don't
 * need to know the SDK's internal module path. In v0.2 the HTTP
 * transport will land alongside as `transport/http.ts`.
 *
 * Convention: this module ONLY constructs and returns the transport.
 * Connecting it to the server is the caller's responsibility (see
 * `cli.ts` for the standard wiring).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function createStdioTransport(): StdioServerTransport {
  return new StdioServerTransport();
}

export { StdioServerTransport };
