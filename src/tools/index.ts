/**
 * Tool registry — the v0.1 catalog. Each tool is a factory that the
 * server instantiates with the SDK client + logger.
 *
 * Order here is the order tools appear in `tools/list` responses to
 * the MCP client. Putting search first is intentional — it's the
 * tool with the broadest read use case.
 */
import type { ToolFactory } from './types.js';
import hybridSearch from './hybrid_search.js';
import recordQuery from './record_query.js';
import recordGet from './record_get.js';
import recordCreate from './record_create.js';
import recordUpdate from './record_update.js';
import recordDelete from './record_delete.js';
import ragAsk from './rag_ask.js';
import documentAsk from './document_ask.js';
import listSchemas from './list_schemas.js';
import documentGet from './document_get.js';
import documentQuery from './document_query.js';
import documentUpdate from './document_update.js';
import documentDelete from './document_delete.js';
import folderQuery from './folder_query.js';
import folderCreate from './folder_create.js';
import folderUpdate from './folder_update.js';
import folderDelete from './folder_delete.js';
import currentIdentity from './current_identity.js';
import documentIngest from './document_ingest.js';
import lookupPrincipal from './lookup_principal.js';
import versionHistory from './version_history.js';

export const ALL_TOOL_FACTORIES: Record<string, ToolFactory> = {
  hybrid_search: hybridSearch,
  record_query: recordQuery,
  record_get: recordGet,
  record_create: recordCreate,
  record_update: recordUpdate,
  record_delete: recordDelete,
  rag_ask: ragAsk,
  document_ask: documentAsk,
  list_schemas: listSchemas,
  document_get: documentGet,
  document_query: documentQuery,
  document_update: documentUpdate,
  document_delete: documentDelete,
  folder_query: folderQuery,
  folder_create: folderCreate,
  folder_update: folderUpdate,
  folder_delete: folderDelete,
  current_identity: currentIdentity,
  document_ingest: documentIngest,
  lookup_principal: lookupPrincipal,
  version_history: versionHistory,
};

export { TOOL_NAMES, type ToolName, type ToolDefinition, type ToolFactory } from './types.js';
