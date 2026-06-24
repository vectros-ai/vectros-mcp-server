/**
 * Build-time provenance for the published MCP server.
 *
 * `@vectros-ai/sdk` is **bundled** into the binary (tsup `noExternal`), so at
 * runtime there is no `node_modules/@vectros-ai/sdk` to read its version from —
 * the only way to know which SDK a given `@vectros-ai/mcp-server` build shipped
 * is to capture it at build time.
 *
 * tsup's `define` (see tsup.config.ts) replaces the `__*_VERSION__` tokens with
 * the versions RESOLVED AT BUILD TIME. Under `tsx` (the test runner, no tsup
 * define) the tokens are undefined → the `'dev'` fallback; the `typeof` guard
 * keeps the else-branch from ReferenceError-ing.
 */
declare const __MCP_VERSION__: string | undefined;
declare const __SDK_VERSION__: string | undefined;

export const BUILD_INFO = {
  mcpServer: typeof __MCP_VERSION__ !== 'undefined' ? __MCP_VERSION__ : 'dev',
  sdk: typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : 'dev',
} as const;

/** One-line provenance string, e.g. `vectros-mcp-server 0.5.0 (sdk 0.29.5)`. */
export function formatBuildInfo(): string {
  return `vectros-mcp-server ${BUILD_INFO.mcpServer} (sdk ${BUILD_INFO.sdk})`;
}
