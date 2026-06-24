/**
 * Public surface of @vectros-ai/mcp-server.
 *
 * Programmatic consumers (rare — most use the CLI):
 *
 *   import { VectrosMCPServer } from '@vectros-ai/mcp-server';
 *   import { createStdioTransport } from '@vectros-ai/mcp-server';
 *
 *   const server = new VectrosMCPServer({
 *     apiKey: process.env.VECTROS_API_KEY!,
 *     tools: ['hybrid_search', 'rag_ask'],
 *   });
 *   await server.connect(createStdioTransport());
 *
 * Most consumers use the CLI shape via `npx -y @vectros-ai/mcp-server`
 * or by configuring it in claude_desktop_config.json — see README.
 */
export { VectrosMCPServer, type VectrosMCPServerOptions } from './server.js';
export { createStdioTransport } from './transport/stdio.js';
export { createLogger, type Logger } from './log.js';
export { InvalidApiKeyError, type KeyPrefix, type KeyEnv } from './auth.js';
export { TOOL_NAMES, type ToolName } from './tools/index.js';
export { RESOURCE_NAMES, type ResourceName } from './resources/index.js';
