/**
 * Shared error-to-tool-result formatting.
 *
 * All tool errors map to MCP `isError: true` responses — never
 * thrown out of the handler. This keeps the JSON-RPC stream clean
 * and lets the agent recover from a tool failure rather than the
 * MCP client tearing down the whole session.
 */
import type { ToolResult } from './types.js';
import { StreamError } from '../sse.js';

interface VectrosErrorShape {
  statusCode?: number;
  message?: string;
  name?: string;
}

/**
 * Format an unknown error into a tool result. Pulls out the
 * Vectros SDK error code + message if present.
 *
 * @param toolName  for log + result framing
 * @param err       the thrown value (Error or unknown)
 * @param docPointer  optional URL to surface for partner-actionable errors
 */
export function toolError(toolName: string, err: unknown, docPointer?: string): ToolResult {
  let summary = `${toolName} failed`;
  let detail = String(err);

  if (err instanceof StreamError) {
    summary = `${toolName} stream error`;
    detail = err.message;
  } else if (err instanceof Error) {
    const e = err as Error & VectrosErrorShape;
    detail = e.message;
    if (e.statusCode) {
      summary = `${toolName} failed: HTTP ${e.statusCode}`;
    } else if (e.name && e.name !== 'Error') {
      summary = `${toolName} failed: ${e.name}`;
    }
  }

  const pointer = docPointer ? `\n\nSee: ${docPointer}` : '';

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${summary}\n${detail}${pointer}`,
      },
    ],
  };
}
