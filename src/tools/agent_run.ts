/**
 * agent_run — wraps `client.agents.createRun(...)` → `POST /v1/runs`.
 *
 * Runs a stored agent on one input and returns its answer. The API streams the
 * run as Server-Sent Events; MCP tools are request/response, so the stream is
 * aggregated into one result (see `run-stream.ts`) while MCP progress
 * notifications keep the call alive for a run that takes minutes.
 *
 * What a run may do and spend:
 *   • Its tool calls act as the caller, with the caller's own permissions, and
 *     only through the tools the stored agent lists. `readOnly: true` refuses
 *     every tool call that would change data.
 *   • `maxInferenceCents` caps what this run's model calls may cost; it can only
 *     lower the agent's own stored budget. A run reserves its budget from a
 *     prepaid inference balance when it starts and returns what it did not use.
 *
 * Retry safety: every call sends an `Idempotency-Key` (the caller's, or a fresh
 * random one), so the SDK's automatic re-send of a refused start can never start
 * a second run. An agent that retries a whole tool call after losing its answer
 * passes the same `idempotencyKey` to get the first run named back instead of a
 * new paid one.
 *
 * Cancellation: when the MCP client cancels the tool call, the run is cancelled
 * through `POST /v1/runs/{id}/cancel` (closing the stream alone stops a run only
 * on a best-effort basis) once the run is named, and the stream is closed. A
 * cancel that arrives before the run is named waits for the name. If the start
 * itself then fails without a clear refusal, the error carries the idempotency
 * key, so a retry names any run that did start.
 *
 * Needs the `runs:c` scope, and agent runs switched on for the tenant by an
 * account owner. Only `runs:c` is exercised: the tool reads nothing else first.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { consumeRunStream } from '../run-stream.js';

const RUN_ID_HEADER = 'x-vectros-run-id';
const MAX_INPUT_CHARS = 100_000;
// The request body is capped at 256 KB. 100,000 characters of a script that takes three or four
// bytes per character in UTF-8, or of control characters that JSON escapes to six bytes each,
// would pass the character limit and be refused for size, so the input's size as it is sent (a
// JSON string, UTF-8 encoded) is checked too, leaving room for the rest of the body.
const MAX_INPUT_BYTES = 240_000;

function encodedInputBytes(v: string): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const ENDED_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);

const inputSchema = {
  agentId: z.string().min(1, 'agentId must be non-empty').describe('The agent to run: an `id` from agent_list.'),
  input: z
    .string()
    .min(1, 'input must be non-empty')
    .max(MAX_INPUT_CHARS, `input accepts at most ${MAX_INPUT_CHARS} characters`)
    .refine(
      (v) => encodedInputBytes(v) <= MAX_INPUT_BYTES,
      `input accepts at most ${MAX_INPUT_BYTES} bytes as sent (a JSON string in UTF-8)`,
    )
    .describe(
      `What the agent is asked, 1 to ${MAX_INPUT_CHARS} characters and at most ${MAX_INPUT_BYTES} bytes as sent ` +
        '(a JSON string in UTF-8; most control characters other than newline and tab count six bytes).',
    ),
  agentVersion: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('The agent version to run. Default: its latest version.'),
  maxInferenceCents: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'The most this run\'s model calls may cost, in US cents. It can only lower the agent\'s own budget (a ' +
        'higher value is refused); a value below the platform minimum is refused with errorCode ' +
        '`BUDGET_TOO_LOW`, whose message names the minimum. Default: the agent\'s budget. A run that reaches it ' +
        'ends `FAILED` with errorCode `BUDGET_EXCEEDED`.',
    ),
  readOnly: z
    .boolean()
    .optional()
    .describe('When true, every tool call that would change data is refused in this run. Default false.'),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'idempotencyKey is 1 to 128 letters, digits, `.`, `_`, `:` or `-`')
    .optional()
    .describe(
      'Makes a retried call safe: the same key with the same arguments never starts a second run; the retry ' +
        'returns that run\'s id and status (`alreadyStarted: true`) instead. Its answer text is not returned ' +
        'again; read how it ended with run_get. Default: a new key per call.',
    ),
};

const agentRun: ToolFactory = ({ client, log }) => ({
  name: 'agent_run',
  title: 'Run an agent',
  description:
    'Run a stored agent (from agent_list) on one `input` and return its answer. The agent\'s tool calls act as ' +
    'you, with your own permissions, and only through the tools the agent lists; set `readOnly` to refuse every ' +
    'tool call that would change data. Cap the run\'s model cost with `maxInferenceCents` (it can only lower the ' +
    'agent\'s own budget). The run is billed: model calls against your inference balance, and a fee per run, tool ' +
    'calls and run time against your plan. An agent can search the web or fetch a page when its definition lists ' +
    'that web tool (web fetch also needs your tenant\'s owner to switch it on, and a run of an agent that lists ' +
    '`web_search` is refused while the platform has web search disabled). Returns `{ runId, agentId, agentVersion, status, terminal, reason, ' +
    'errorCode, text, toolCalls, charged }`; `charged` carries the run\'s charge and refund in milli-cents (1 cent = 1000). Progress notifications keep the call ' +
    'alive while the run works for a client that resets its timeout on progress; cancelling the call cancels the ' +
    'run once the run is named (almost at once). If `terminal` is false the result arrived ' +
    'before the run ended: read it with run_get, which needs `runs:r` as well. Calling again without ' +
    '`idempotencyKey` starts a new, billed run. Needs the `runs:c` scope.',
  inputSchema,
  // Not a read: a run is billed, and its tool calls may create, change or delete data with the
  // caller's permissions, so a host should confirm it. Not idempotent: each call is a new paid run
  // unless the same idempotencyKey is passed again.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, extra): Promise<ToolResult> => {
    const agentId = args.agentId as string;
    const maxInferenceCents = args.maxInferenceCents as number | undefined;
    const idempotencyKey = (args.idempotencyKey as string | undefined) ?? randomUUID();
    const request: Vectros.CreateRunRequest = {
      'Idempotency-Key': idempotencyKey,
      agentId,
      agentVersion: args.agentVersion as number | undefined,
      input: { text: args.input as string },
      budget: maxInferenceCents !== undefined ? { maxInferenceCents } : undefined,
      readOnly: args.readOnly as boolean | undefined,
    };

    const progressToken = extra._meta?.progressToken;
    let progressCount = 0;
    const onProgress =
      progressToken !== undefined && extra.sendNotification
        ? async (message: string) => {
            progressCount += 1;
            await extra.sendNotification!({
              method: 'notifications/progress',
              params: { progressToken, progress: progressCount, message },
            });
          }
        : undefined;

    // Cancellation. The platform may already have started the run before its response headers
    // arrive, so the stream is never closed before the run has been named: a cancel is recorded,
    // and as soon as the run's id is known (from the headers, or failing that from the stream's
    // first event) the run is cancelled by id and the stream closed. (The SDK's own request
    // timeout bounds the wait for headers.)
    const streamAbort = new AbortController();
    const callSignal = extra.signal;
    let knownRunId: string | undefined;
    let headersReceived = false;
    let cancelRequested = false;
    let cancelSent = false;
    // Set once the stream's terminal event has been read: a run that has ended is never cancelled.
    let runEnded = false;
    const sendCancel = () => {
      if (!cancelRequested || cancelSent || !knownRunId || runEnded) return;
      cancelSent = true;
      const id = knownRunId;
      client.agents.cancelRun({ id }).then(
        () => log.info({ tool: 'agent_run', runId: id }, 'agent_run cancelled by the client'),
        (err: unknown) => log.warn({ tool: 'agent_run', runId: id, err: String(err) }, 'agent_run cancel failed'),
      );
    };
    const cancelIfNamed = () => {
      if (!cancelRequested || !headersReceived || !knownRunId) return;
      sendCancel();
      streamAbort.abort();
    };
    const onCancel = () => {
      cancelRequested = true;
      cancelIfNamed();
    };
    if (callSignal?.aborted) {
      return toolError('agent_run', new Error('The call was cancelled before the run started.'));
    }
    callSignal?.addEventListener('abort', onCancel, { once: true });

    try {
      const { data: stream, rawResponse } = await client.agents
        .createRun(request, { abortSignal: streamAbort.signal })
        .withRawResponse();
      headersReceived = true;
      knownRunId = rawResponse.headers.get(RUN_ID_HEADER) ?? undefined;
      cancelIfNamed();

      // Without the header, the first event that carries `runId` names the run.
      const naming = async function* (): AsyncGenerator<unknown> {
        for await (const ev of stream as AsyncIterable<unknown>) {
          if (!knownRunId && ev && typeof ev === 'object') {
            const id = (ev as { runId?: unknown }).runId;
            if (typeof id === 'string' && id.length > 0) {
              knownRunId = id;
              cancelIfNamed();
            }
          }
          if (ev && typeof ev === 'object') {
            const e = ev as { terminal?: unknown; type?: unknown };
            if (e.terminal === true || (typeof e.type === 'string' && TERMINAL_EVENT_TYPES.has(e.type))) runEnded = true;
          }
          yield ev;
        }
      };

      const run = await consumeRunStream(naming(), knownRunId, onProgress);
      knownRunId ??= run.runId;
      if (run.terminal) runEnded = true;
      sendCancel();

      log.debug(
        {
          tool: 'agent_run',
          runId: run.runId,
          status: run.status,
          terminal: run.terminal,
          toolCalls: run.toolCalls.length,
          textLength: run.text.length,
        },
        'agent_run ok',
      );

      const body: Record<string, unknown> = {
        runId: run.runId,
        agentId: run.agentId ?? agentId,
        agentVersion: run.agentVersion,
        status: run.status,
        terminal: run.terminal,
        reason: run.reason,
        errorCode: run.errorCode,
        text: run.text,
        toolCalls: run.toolCalls,
        charged: run.charged,
      };
      if (!run.terminal) {
        body.note = cancelRequested
          ? 'The call was cancelled and the run was asked to stop. Read it with run_get (needs the `runs:r` ' +
            'scope) to see how it ended.'
          : 'The stream ended before the run did' +
            (run.streamError ? ` (${run.streamError})` : '') +
            '. The run may still be working: read it with run_get until `terminal` is true (run_get needs the ' +
            '`runs:r` scope).';
      }
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
    } catch (err) {
      // This idempotency key already started a run: either the caller retried with its own key,
      // or the SDK re-sent a start whose first answer was lost. Either way that run is the
      // answer to this call, so it is named (not reported as a failure, which would invite a
      // second paid run).
      const e = err as {
        body?: { errorCode?: unknown; runId?: unknown; status?: unknown };
        rawResponse?: { headers?: Headers };
      } | null;
      if (e?.body?.errorCode === 'IDEMPOTENCY_IN_PROGRESS') {
        const runId =
          (typeof e.body.runId === 'string' ? e.body.runId : undefined) ??
          e.rawResponse?.headers?.get?.(RUN_ID_HEADER) ??
          undefined;
        if (runId) {
          const status = typeof e.body.status === 'string' ? e.body.status : undefined;
          // No cancel here, even if this call was cancelled: the run may belong to another call that
          // is still reading it with the same key.
          log.info({ tool: 'agent_run', runId }, 'agent_run: the idempotency key already started a run');
          const body = {
            runId,
            agentId,
            status,
            // The 409 names the run's status at the time; an ended status is final.
            terminal: status !== undefined && ENDED_STATUSES.has(status),
            alreadyStarted: true,
            note:
              'This idempotency key already started this run, so no new run was started. Its answer text ' +
              'is not returned again and cannot be read back: run_get (needs the `runs:r` scope) shows how ' +
              'the run ended and what it was charged, never its text. To start another run, pass a new ' +
              'idempotencyKey.',
          };
          return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
        }
      }
      log.warn({ tool: 'agent_run', agentId, err: String(err) }, 'agent_run failed');
      const result = toolError('agent_run', err);
      // A start that failed without a clear refusal (no status: a dropped connection or a timeout;
      // a 408; or a 5xx) may still have started a run, which this call can then neither read nor cancel.
      // The key lets a retry name that run instead of starting a second one.
      const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
      if (typeof statusCode !== 'number' || statusCode === 408 || statusCode >= 500) {
        result.content[0]!.text +=
          `\nidempotencyKey: ${idempotencyKey}\nA run may have started before this error. Call agent_run again ` +
          'with the same arguments and this idempotencyKey: if a run started, the call names it; if not, it starts one.' +
          (cancelRequested ? ' (The call was cancelled; a run that started could not be cancelled.)' : '');
      }
      return result;
    } finally {
      callSignal?.removeEventListener('abort', onCancel);
    }
  },
});

export default agentRun;
