/**
 * Agent-run stream consumer with MCP progress emission.
 *
 * `POST /v1/runs` answers with a Server-Sent Events stream whose events carry a
 * `type` discriminator:
 *
 *   run.started        the run began (carries `runId`, `agentId`, `agentVersion`)
 *   message.delta      the next piece of the agent's answer (`text`)
 *   message.completed  one model call's complete answer text (`text`, `step`)
 *   tool.completed     a tool call ended (`tool`, `outcome`, `code`; never its arguments or result)
 *   run.completed      terminal: the run ended normally
 *   run.failed         terminal: the run failed (`errorCode`)
 *   run.cancelled      terminal: the run was stopped (`errorCode`)
 *
 * Every event carries `runId`, `seq` and `terminal`. The consumer rules this
 * helper applies:
 *   1. Stop at the event with `terminal: true`. The SDK's iterator only ends when
 *      the connection closes, so the loop breaks itself rather than waiting.
 *   2. Ignore an event `type` or a field it does not know. An unknown event that
 *      says `terminal: true` still ends the stream.
 *   3. A stream that ends without a terminal event, or breaks off with an error
 *      after the run started, is not a failed run: the run may still be going or
 *      may have ended unseen. The result then says `terminal: false` and the
 *      caller reads the run with `GET /v1/runs/{id}`.
 *
 * Progress: an MCP client times out a tool call that stays silent, and a run can
 * last minutes. A notification is sent when the run starts, after every tool
 * call, at the end of every model call, for the answer text at most once per
 * {@link TEXT_PROGRESS_CHARS} new characters (so a long answer does not become a
 * notification per token), and every {@link HEARTBEAT_MS} milliseconds while no
 * event arrives (a long tool call or model call sends no event for a while).
 * Progress is best effort: a notification that fails is dropped, and the run
 * is still read to its end.
 */

/** New answer characters between two text progress notifications. */
export const TEXT_PROGRESS_CHARS = 256;

/** Milliseconds without an event before a "still working" progress notification. */
export const HEARTBEAT_MS = 15_000;

/** One tool call of a run, as the stream reports it. */
export interface RunToolCallSummary {
  tool?: string;
  outcome?: string;
  code?: string;
}

/** What a run was charged on the inference balance, in milli-cents (1 cent = 1000). */
export interface RunCharge {
  /** Whether the charge was settled as the stream ended; if not, `GET /v1/runs/{id}` has the amounts. */
  settled?: boolean;
  inferenceBalanceCentsChargedMilli?: number;
  inferenceBalanceCentsRefundedMilli?: number;
}

export interface AggregatedRun {
  /** The run's id, from the stream's events or the response header. */
  runId?: string;
  agentId?: string;
  agentVersion?: number;
  /** Whether a terminal event arrived. `false` means: read the run to learn how it ends. */
  terminal: boolean;
  /** The terminal event's `status` (`COMPLETED`, `FAILED`, `CANCELLED`, ...), or `UNKNOWN` when none was seen. */
  status: string;
  reason?: string;
  errorCode?: string;
  /** The answer: each model call's text, in order, separated by a blank line. */
  text: string;
  toolCalls: RunToolCallSummary[];
  /** Present when the terminal event reported the charge. */
  charged?: RunCharge;
  /** Set when the stream broke off with an error before a terminal event. */
  streamError?: string;
}

export type RunProgressEmitter = (message: string) => void | Promise<void>;

type RunEvent = { type?: unknown; [k: string]: unknown };

const TERMINAL_STATUS: Record<string, string> = {
  'run.completed': 'COMPLETED',
  'run.failed': 'FAILED',
  'run.cancelled': 'CANCELLED',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Consume a run stream into one result, emitting progress as it goes.
 *
 * Never throws for a stream that breaks off: the error is recorded in
 * `streamError` with `terminal: false`, because the run itself may be unaffected.
 *
 * @param stream      the iterable from the SDK's `agents.createRun`
 * @param initialRunId the run id from the response header, if the caller has it
 * @param onProgress  called with a short message per progress point; omit for none
 * @param heartbeatMs the quiet interval before a "still working" notification
 */
export async function consumeRunStream(
  stream: AsyncIterable<unknown>,
  initialRunId?: string,
  onProgress?: RunProgressEmitter,
  heartbeatMs: number = HEARTBEAT_MS,
): Promise<AggregatedRun> {
  const result: AggregatedRun = {
    runId: initialRunId,
    terminal: false,
    status: 'UNKNOWN',
    text: '',
    toolCalls: [],
  };
  const blocks: string[] = [];
  let pending = '';
  let unsentChars = 0;

  const emit = async (message: string): Promise<void> => {
    if (!onProgress) return;
    try {
      await onProgress(message);
    } catch {
      // Best effort: a lost progress message must not end the read of a run that is still working.
    }
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastEventAt = Date.now();
  if (onProgress) {
    heartbeat = setInterval(() => {
      if (Date.now() - lastEventAt >= heartbeatMs) {
        lastEventAt = Date.now();
        void emit('run still working');
      }
    }, Math.max(1, Math.floor(heartbeatMs / 3)));
    heartbeat.unref?.();
  }

  try {
    for await (const raw of stream) {
      lastEventAt = Date.now();
      if (!raw || typeof raw !== 'object') continue;
      const ev = raw as RunEvent;
      result.runId ??= str(ev.runId);
      const type = typeof ev.type === 'string' ? ev.type : '';

      switch (type) {
        case 'run.started':
          result.agentId = str(ev.agentId) ?? result.agentId;
          result.agentVersion = num(ev.agentVersion) ?? result.agentVersion;
          await emit('run started');
          break;
        case 'message.delta': {
          const piece = typeof ev.text === 'string' ? ev.text : '';
          pending += piece;
          unsentChars += piece.length;
          if (unsentChars >= TEXT_PROGRESS_CHARS) {
            unsentChars = 0;
            await emit(`answer: ${blocks.join('\n\n').length + pending.length} characters so far`);
          }
          break;
        }
        case 'message.completed': {
          // The completed text is authoritative for its model call; the deltas
          // before it were the same text in pieces.
          const full = str(ev.text) ?? pending;
          if (full.length > 0) blocks.push(full);
          pending = '';
          unsentChars = 0;
          await emit('model call completed');
          break;
        }
        case 'tool.completed': {
          const call: RunToolCallSummary = {
            tool: str(ev.tool),
            outcome: str(ev.outcome),
            code: str(ev.code),
          };
          result.toolCalls.push(call);
          await emit(`tool ${call.tool ?? 'call'}: ${call.outcome ?? 'ended'}`);
          break;
        }
        default:
          break;
      }

      // The set of terminal event types is closed, so a terminal type ends the stream even if a
      // malformed event leaves out its `terminal` flag.
      if (ev.terminal === true || Object.hasOwn(TERMINAL_STATUS, type)) {
        result.terminal = true;
        result.status = str(ev.status) ?? TERMINAL_STATUS[type] ?? 'ENDED';
        result.reason = str(ev.reason);
        result.errorCode = str(ev.errorCode);
        if (
          typeof ev.settled === 'boolean' ||
          ev.inferenceBalanceCentsChargedMilli !== undefined ||
          ev.inferenceBalanceCentsRefundedMilli !== undefined
        ) {
          result.charged = {
            settled: typeof ev.settled === 'boolean' ? ev.settled : undefined,
            inferenceBalanceCentsChargedMilli: num(ev.inferenceBalanceCentsChargedMilli),
            inferenceBalanceCentsRefundedMilli: num(ev.inferenceBalanceCentsRefundedMilli),
          };
        }
        break;
      }
    }
  } catch (err) {
    result.streamError = err instanceof Error ? err.message : String(err);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  // Text of a model call the stream did not see complete is kept, not dropped.
  if (pending.length > 0) blocks.push(pending);
  result.text = blocks.join('\n\n');
  return result;
}
