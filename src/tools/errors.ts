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
  // The SDK maps every 4xx/5xx to a VectrosError whose `.body` is the PARSED JSON
  // error body — the API's `{ message, errorCode?, requestId? }` shape. Critically,
  // the Error's own `.message` is only the class name ("PaymentRequiredError"), so
  // the actionable text + typed code live in `.body` and would be lost if we read
  // `.message` alone.
  body?: unknown;
}

/** The parsed API error body: an actionable message plus an optional typed code + request id. */
interface VectrosErrorBody {
  message?: string;
  errorCode?: string;
  requestId?: string;
}

/** The body fields reported on their own lines; every other top-level field is passed through after them. */
const NAMED_BODY_FIELDS: ReadonlySet<string> = new Set(['message', 'errorCode', 'requestId']);
/** Compared in any letter case, so no extra field can pose as one of them (`Errorcode`, `RequestId`). */
const NAMED_BODY_FIELDS_LOWER: ReadonlySet<string> = new Set([...NAMED_BODY_FIELDS].map((k) => k.toLowerCase()));
/** At most this many extra fields, each value cut to this many characters: an error stays readable in an agent's context. */
const MAX_EXTRA_FIELDS = 10;
const MAX_EXTRA_VALUE_CHARS = 500;

/**
 * The refusal's other fields, one `name: value` line each (values as JSON), so an agent sees what the API added to explain it: for
 * example the image types a media upload accepts (`acceptedTypes`, `convertTo`) or when a capped agent can run again (`period`,
 * `resetsAt`).
 */
function extraBodyLines(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const lines: string[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    // Only identifier-shaped names, so a field cannot pose as another line of the error.
    if (
      NAMED_BODY_FIELDS_LOWER.has(key.toLowerCase()) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
      value === undefined ||
      value === null
    ) {
      continue;
    }
    if (lines.length >= MAX_EXTRA_FIELDS) break;
    let text: string;
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      continue;
    }
    if (text === undefined) continue;
    // One line per field: a line break in a value could otherwise forge an `errorCode:` or `requestId:` line.
    text = text.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
    if (text.length > MAX_EXTRA_VALUE_CHARS) {
      // Never cut a surrogate pair in half.
      const end = /[\uD800-\uDBFF]/.test(text.charAt(MAX_EXTRA_VALUE_CHARS - 1)) ? MAX_EXTRA_VALUE_CHARS - 1 : MAX_EXTRA_VALUE_CHARS;
      text = `${text.slice(0, end)}…`;
    }
    lines.push(`\n${key}: ${text}`);
  }
  return lines.join('');
}

function asErrorBody(body: unknown): VectrosErrorBody | undefined {
  if (body && typeof body === 'object') return body as VectrosErrorBody;
  return undefined;
}

/**
 * Format an unknown error into a tool result. Pulls out the Vectros SDK's
 * parsed error body — the actionable server `message`, the typed `errorCode`
 * an agent can branch on (0.36.0: `INSUFFICIENT_BALANCE` vs
 * `SUBSCRIPTION_LIMIT_EXCEEDED` on inference 402s; the placement/identity 403s;
 * the 64-bit-range 400s), and the `requestId` to quote to support.
 *
 * @param toolName  for log + result framing
 * @param err       the thrown value (Error or unknown)
 * @param docPointer  optional URL to surface for errors the caller can act on
 */
export function toolError(toolName: string, err: unknown, docPointer?: string): ToolResult {
  let summary = `${toolName} failed`;
  let detail = String(err);
  let errorCode: string | undefined;
  let requestId: string | undefined;
  let extra = '';

  if (err instanceof StreamError) {
    summary = `${toolName} stream error`;
    detail = err.message;
  } else if (err instanceof Error) {
    const e = err as Error & VectrosErrorShape;
    detail = e.message;
    // Prefer the parsed server body — `e.message` on an SDK error is only the
    // class name; the human-readable reason + typed code + correlation id are
    // in `.body`.
    const body = asErrorBody(e.body);
    if (body) {
      if (typeof body.message === 'string' && body.message.trim().length > 0) detail = body.message;
      if (typeof body.errorCode === 'string' && body.errorCode.length > 0) errorCode = body.errorCode;
      if (typeof body.requestId === 'string' && body.requestId.length > 0) requestId = body.requestId;
      extra = extraBodyLines(e.body);
    }
    if (e.statusCode) {
      summary = `${toolName} failed: HTTP ${e.statusCode}${errorCode ? ` (${errorCode})` : ''}`;
    } else if (e.name && e.name !== 'Error') {
      summary = `${toolName} failed: ${e.name}`;
    }
  }

  const trailer =
    (errorCode ? `\nerrorCode: ${errorCode}` : '') +
    extra +
    (requestId ? `\nrequestId: ${requestId}` : '') +
    (docPointer ? `\n\nSee: ${docPointer}` : '');

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${summary}\n${detail}${trailer}`,
      },
    ],
  };
}
