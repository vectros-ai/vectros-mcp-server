/**
 * Parse the `VECTROS_MCP_TOOLS` env var into a validated ToolName[].
 *
 *   undefined / empty → undefined (caller defaults to all tools)
 *   CSV of valid names → ToolName[]
 *   any invalid name → throws (caller maps to fail-fast exit)
 *
 * Exported as a pure function so it can be unit-tested without
 * spawning the CLI. cli.ts wraps the throw → process.exit(1).
 */
import { TOOL_NAMES, type ToolName } from './tools/index.js';

export function parseToolsEnv(value: string | undefined): ToolName[] | undefined {
  if (!value || value.trim().length === 0) return undefined;
  const requested = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) return undefined;
  const invalid = requested.filter((n) => !TOOL_NAMES.includes(n as ToolName));
  if (invalid.length > 0) {
    throw new Error(
      `VECTROS_MCP_TOOLS contains unknown tool names: ${invalid.join(', ')}. ` +
        `Valid: ${TOOL_NAMES.join(', ')}.`,
    );
  }
  return requested as ToolName[];
}
