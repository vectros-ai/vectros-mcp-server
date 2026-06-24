/**
 * SSE-stream consumer with MCP progress emission.
 *
 * The Vectros SDK's inference methods (`client.inference.ragInference`,
 * `client.inference.documentAsk`) return `AsyncIterable<Event>` where
 * each event has shape:
 *
 *   { event: 'search_results',    ... }   // rag only, fires first
 *   { event: 'document_context',  ... }   // document_ask only, fires first
 *   { event: 'content_delta',     delta: '...' }  // many; aggregate
 *   { event: 'truncation_warning', ... }  // optional
 *   { event: 'done',  inputTokens, outputTokens, model, ...credits }
 *   { event: 'error', message: '...', code: '...' }
 *
 * NOTE (SDK 0.23): the delta field is `delta` (NOT `text`), and `done`
 * carries flat token/billing fields (NOT a nested `usage` object). Reading
 * the pre-0.23 names silently aggregates an EMPTY answer — the SDK stream is
 * consumed via an `as` cast so tsc can't catch the drift; only a live smoke
 * does. See tests/03-rag-ask + tests/11 against staging.
 *
 * This helper:
 *   1. Iterates the stream.
 *   2. Aggregates `content_delta.delta` into a single answer string.
 *   3. Captures the once-only events (`search_results`,
 *      `document_context`, `truncation_warning`, `done`) into the
 *      result envelope (`done` minus its discriminator → `usage`).
 *   4. Emits each `content_delta` as an MCP progress notification
 *      via the `onProgress` callback so the MCP client doesn't
 *      timeout the tool call on a 30-45s RAG generation. See
 *      the design doc § "Long-running tool calls".
 *
 * The helper is decoupled from the MCP SDK — the `onProgress`
 * callback is wired by the tool implementation against the
 * RequestHandlerExtra.sendNotification API.
 */

export type SseEvent =
  | { event: 'search_results'; [k: string]: unknown }
  | { event: 'document_context'; [k: string]: unknown }
  | { event: 'content_delta'; delta: string }
  | { event: 'truncation_warning'; [k: string]: unknown }
  | { event: 'done'; [k: string]: unknown }
  | { event: 'error'; message?: string; [k: string]: unknown };

export interface AggregatedResult {
  /** Full concatenated text from all `content_delta` events. */
  answer: string;
  /** The `search_results` event payload, if present (rag_ask only). */
  searchResults?: Record<string, unknown>;
  /** The `document_context` event payload, if present (document_ask only). */
  documentContext?: Record<string, unknown>;
  /** The `truncation_warning` event payload, if present. */
  truncationWarning?: Record<string, unknown>;
  /** The `done` event payload (token + billing fields), if present. */
  usage?: Record<string, unknown>;
}

export type ProgressEmitter = (chunk: { text: string; total: number }) => void | Promise<void>;

export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamError';
  }
}

/**
 * Consume an SSE-event stream, emit progress notifications per
 * `content_delta`, and return the aggregated result envelope.
 *
 * @param stream  AsyncIterable from `client.inference.ragInference`
 *                or `client.inference.documentAsk`.
 * @param onProgress  Called once per `content_delta` event. The
 *                    `total` field is the running cumulative character
 *                    count of the answer buffer (useful for MCP
 *                    progress percent if the client wants it).
 *                    If omitted, no progress notifications are
 *                    emitted (handy for tests).
 *
 * @throws StreamError if the stream emits an `event: 'error'` event.
 */
export async function consumeStream<T extends SseEvent>(
  stream: AsyncIterable<T>,
  onProgress?: ProgressEmitter,
): Promise<AggregatedResult> {
  let answer = '';
  let searchResults: Record<string, unknown> | undefined;
  let documentContext: Record<string, unknown> | undefined;
  let truncationWarning: Record<string, unknown> | undefined;
  let usage: Record<string, unknown> | undefined;

  for await (const ev of stream) {
    switch (ev.event) {
      case 'search_results': {
        const { event: _e, ...rest } = ev;
        searchResults = rest;
        break;
      }
      case 'document_context': {
        const { event: _e, ...rest } = ev;
        documentContext = rest;
        break;
      }
      case 'content_delta': {
        // SDK 0.23: the chunk field is `delta` (was `text` pre-0.23).
        const delta = (ev as { delta?: string }).delta ?? '';
        answer += delta;
        if (onProgress) {
          await onProgress({ text: delta, total: answer.length });
        }
        break;
      }
      case 'truncation_warning': {
        const { event: _e, ...rest } = ev;
        truncationWarning = rest;
        break;
      }
      case 'done': {
        // SDK 0.23: `done` carries flat token/billing fields (inputTokens,
        // outputTokens, model, …credits) — not a nested `usage`. Capture the
        // whole payload minus the discriminator.
        const { event: _e, ...rest } = ev;
        usage = rest;
        break;
      }
      case 'error': {
        const message = (ev as { message?: string }).message ?? 'Unknown stream error';
        throw new StreamError(message);
      }
    }
  }

  return { answer, searchResults, documentContext, truncationWarning, usage };
}
