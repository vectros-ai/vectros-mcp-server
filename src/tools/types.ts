/**
 * Shared tool-definition shape.
 *
 * Each tool is built as a factory that takes the Vectros SDK client
 * (already authenticated) + a logger, and returns the registration
 * payload for `server.registerTool()` plus the handler. The server
 * class iterates the array and registers each one.
 */
import type { ZodRawShape } from 'zod';
import type { VectrosClient } from '@vectros-ai/sdk';
import type { Logger } from '../log.js';

/**
 * Names of all REGISTERED tools — the contract for what
 * `tools: [...]` accepts and what default construction registers.
 *
 * MUST stay in lockstep with `ALL_TOOL_FACTORIES` in `./index.ts` —
 * every name here needs a factory there, and vice versa. The server
 * iterates this list at construction; an unimplemented name throws.
 *
 * v0.1 (shipped 2026-05-30): hybrid_search, record_query, rag_ask, document_ask
 * v0.2 (shipped):             list_schemas, document_get, current_identity, document_ingest
 * launch data-plane I/O:      record_get, record_create, record_update, record_delete (tier 1);
 *                             document_query (tier 2);
 *                             document_update, document_delete, folder_query,
 *                             folder_create, folder_update, folder_delete (tier 3)
 *                             (see the data-plane surface doc)
 * parity sweep:               lookup_principal (identity resolution for the
 *                             ownership filters), version_history (record/document
 *                             audit trail)
 */
export const TOOL_NAMES = [
  'hybrid_search',
  'record_query',
  'record_get',
  'record_create',
  'record_update',
  'record_delete',
  'rag_ask',
  'document_ask',
  'list_schemas',
  'document_get',
  'document_query',
  'document_update',
  'document_delete',
  'folder_query',
  'folder_create',
  'folder_update',
  'folder_delete',
  'current_identity',
  'document_ingest',
  'lookup_principal',
  'version_history',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * MCP tool-handler context. The MCP SDK passes this as the second
 * arg to tool handlers. We type it loosely — the bits we use are
 * `sendNotification` (for progress) and `signal` (for abort).
 */
export interface ToolExtra {
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
  _meta?: { progressToken?: string | number };
  signal?: AbortSignal;
}

/**
 * MCP tool-result shape — what every handler returns. The MCP SDK
 * normalizes this into a `tools/call` response.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition<S extends ZodRawShape = ZodRawShape> {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: S;
  handler: (args: Record<string, unknown>, extra: ToolExtra) => Promise<ToolResult>;
}

export interface ToolFactoryContext {
  client: VectrosClient;
  log: Logger;
  /**
   * The API key the server was constructed with. Optional in the
   * type because most tools don't need it (the SDK `client` carries
   * it implicitly) and test mocks shouldn't have to provide it.
   * Production server.ts ALWAYS supplies it.
   *
   * Only `current_identity` uses this — for raw-fetch access to
   * /v1/ping that the SDK's typed `ping()` discards (it's typed
   * `Promise<void>` and throws away the response body).
   * Graceful-degradation contract requires raw access until the
   * SDK regenerates for the extended ping shape.
   */
  apiKey?: string;
  /** The resolved API base URL. Same rationale as `apiKey`. */
  environment?: string;
  /**
   * Which transport is wired up. Optional in the type because most
   * tools are transport-agnostic and test mocks shouldn't have to
   * provide it. Production CLI entry points (`cli.ts` for stdio,
   * `cli-http.ts` for HTTP) pass the appropriate value.
   *
   * Only `document_ingest` uses this — to reject `filePath` mode on
   * HTTP transport (remote MCP server can't touch the partner's
   * local filesystem; design doc § Documents → document_ingest).
   * Undefined treated as 'stdio' (the v0.1 default).
   */
  transport?: 'stdio' | 'http';
  /**
   * Filesystem root that `document_ingest`'s stdio `filePath` mode is
   * jailed to. A model-supplied path is canonicalized and must
   * resolve INSIDE this root; traversal / absolute-escape / symlink-escape
   * are rejected. Defaults to `VECTROS_MCP_INGEST_ROOT ?? process.cwd()`.
   * Only `document_ingest` reads it.
   */
  ingestRoot?: string;
}

export type ToolFactory = (ctx: ToolFactoryContext) => ToolDefinition;
