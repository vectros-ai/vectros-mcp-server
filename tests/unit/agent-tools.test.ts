/**
 * agent_list, agent_run and run_get against a mocked SDK client.
 *
 * Each mock client carries ONLY the SDK methods the tool is expected to call, so a
 * tool that reached for another endpoint (and so for another scope) fails with a
 * TypeError instead of passing quietly. That is how "a tool exercises only the
 * scope it documents" is pinned: agent_run uses `runs:c` alone (start, and cancel
 * on cancellation), run_get `runs:r`, agent_list `runs:c` or `agents:r`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { z } from 'zod';

import agentList from '../../src/tools/agent_list.js';
import agentRun from '../../src/tools/agent_run.js';
import runGet from '../../src/tools/run_get.js';
import { consumeRunStream, TEXT_PROGRESS_CHARS } from '../../src/run-stream.js';
import type { ToolExtra } from '../../src/tools/types.js';

const log = pino({ level: 'silent' });
const RUN_ID = '0123456789abcdef0123456789abcdef';

function parsed(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  assert.equal(result.content[0]?.type, 'text');
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** An SDK-shaped error: a status code plus the parsed API error body. */
function apiError(statusCode: number, body: Record<string, unknown>): Error {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, body });
}

async function* events(list: unknown[]): AsyncGenerator<unknown> {
  for (const ev of list) yield ev;
}

const ev = (type: string, fields: Record<string, unknown> = {}, seq = 0) => ({
  type,
  runId: RUN_ID,
  seq,
  terminal: false,
  ...fields,
});

/** A client whose `agents` namespace has only the given methods. */
function agentsClient(methods: Record<string, (...a: unknown[]) => unknown>) {
  return { agents: methods } as never;
}

/** createRun as the SDK returns it: an HttpResponsePromise with `withRawResponse()`. */
function createRunReturning(
  stream: AsyncIterable<unknown>,
  headers: Record<string, string> = { 'X-Vectros-Run-Id': RUN_ID },
  record?: (req: unknown, opts: unknown) => void,
) {
  return (req: unknown, opts: unknown) => {
    record?.(req, opts);
    return {
      withRawResponse: async () => ({ data: stream, rawResponse: { headers: new Headers(headers) } }),
    };
  };
}

function progressExtra(): { extra: ToolExtra; messages: string[]; values: number[] } {
  const messages: string[] = [];
  const values: number[] = [];
  const extra: ToolExtra = {
    _meta: { progressToken: 'tok-1' },
    sendNotification: async (n) => {
      messages.push(n.params.message ?? '');
      values.push(n.params.progress);
    },
  };
  return { extra, messages, values };
}

// ============================================================================
// agent_list
// ============================================================================

test('agent_list forwards its filters, defaults the limit to 10, and returns the summary fields only', async () => {
  const calls: unknown[] = [];
  const client = agentsClient({
    listAgents: async (req: unknown) => {
      calls.push(req);
      return {
        data: [
          // A credential with agents:r gets the whole definition; the tool keeps the summary.
          {
            id: 'agt_1',
            name: 'intake-triage',
            description: 'Sorts new intake forms',
            latestVersion: 3,
            status: 'ACTIVE',
            system: 'You are a triage assistant.',
            tools: [{ name: 'records.query' }],
            model: 'claude-sonnet-5-5',
          },
          // A runs:c-only credential gets the summary from the API already.
          { id: 'agt_2', name: 'summarizer', latestVersion: 1, status: 'ACTIVE' },
        ],
        nextCursor: 'cur_2',
      };
    },
  });
  const tool = agentList({ client, log });

  const r = await tool.handler({ includeRetired: true, startFrom: 'cur_1' }, {});
  assert.ok(!r.isError);
  assert.deepEqual(calls[0], { includeRetired: true, startFrom: 'cur_1', limit: 10 });
  const body = parsed(r) as { data: Array<Record<string, unknown>>; nextCursor: string | null };
  assert.equal(body.nextCursor, 'cur_2');
  assert.deepEqual(body.data[0], {
    id: 'agt_1',
    name: 'intake-triage',
    description: 'Sorts new intake forms',
    latestVersion: 3,
    status: 'ACTIVE',
  });
  assert.equal((body.data[0] as Record<string, unknown>).system, undefined, 'the system prompt never reaches the agent context');
  assert.deepEqual(Object.keys(body.data[1]!).sort(), ['id', 'latestVersion', 'name', 'status']);

  await tool.handler({ limit: 100 }, {});
  assert.equal((calls[1] as { limit: number }).limit, 100, 'a raised limit is forwarded, not re-clamped');
});

test('agent_list on the last page returns nextCursor null and an empty data array', async () => {
  const client = agentsClient({ listAgents: async () => ({ data: undefined, nextCursor: null }) });
  const r = await agentList({ client, log }).handler({}, {});
  assert.deepEqual(parsed(r), { data: [], nextCursor: null });
});

test('agent_list without runs:c or agents:r: the 403 is a tool error naming the status and errorCode', async () => {
  const client = agentsClient({
    listAgents: async () => {
      throw apiError(403, { message: 'Your credential cannot list agents.', errorCode: 'FORBIDDEN' });
    },
  });
  const r = await agentList({ client, log }).handler({}, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /agent_list failed: HTTP 403 \(FORBIDDEN\)/);
  assert.match(r.content[0]!.text, /cannot list agents/);
});

// ============================================================================
// agent_run
// ============================================================================

test('agent_run starts the run, aggregates the stream, and calls nothing but createRun', async () => {
  const requests: Array<{ req: Record<string, unknown>; opts: Record<string, unknown> }> = [];
  const stream = events([
    ev('run.started', { agentId: 'agt_1', agentVersion: 3 }, 0),
    ev('message.delta', { text: 'Looking ' }, 1),
    ev('message.delta', { text: 'it up.' }, 1),
    ev('message.completed', { step: 1, text: 'Looking it up.' }, 1),
    ev('tool.completed', { step: 1, toolCallId: 't1', tool: 'records.query', outcome: 'OK' }, 2),
    ev('message.completed', { step: 2, text: 'Found 2 open forms.' }, 3),
    {
      ...ev('run.completed', {}, 4),
      terminal: true,
      status: 'COMPLETED',
      reason: 'end_turn',
      settled: true,
      inferenceBalanceCentsChargedMilli: 4200,
      inferenceBalanceCentsRefundedMilli: 95800,
    },
  ]);
  const client = agentsClient({
    createRun: createRunReturning(stream, undefined, (req, opts) =>
      requests.push({ req: req as Record<string, unknown>, opts: opts as Record<string, unknown> }),
    ),
  });
  const { extra, messages, values } = progressExtra();

  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'Which forms are open?' }, extra);
  assert.ok(!r.isError, r.content[0]!.text);

  const req = requests[0]!.req;
  assert.equal(req.agentId, 'agt_1');
  assert.deepEqual(req.input, { text: 'Which forms are open?' });
  assert.equal(req.budget, undefined, 'no budget sent: the agent\'s own budget applies');
  assert.equal(req.readOnly, undefined);
  assert.match(String(req['Idempotency-Key']), /^[A-Za-z0-9._:-]{1,128}$/, 'every start carries an idempotency key');
  assert.ok(requests[0]!.opts.abortSignal instanceof AbortSignal, 'the stream can be closed with the call');

  const body = parsed(r);
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.agentId, 'agt_1');
  assert.equal(body.agentVersion, 3);
  assert.equal(body.status, 'COMPLETED');
  assert.equal(body.terminal, true);
  assert.equal(body.reason, 'end_turn');
  assert.equal(body.text, 'Looking it up.\n\nFound 2 open forms.', 'one block per model call, not the deltas twice');
  assert.deepEqual(body.toolCalls, [{ tool: 'records.query', outcome: 'OK' }]);
  assert.deepEqual(body.charged, {
    settled: true,
    inferenceBalanceCentsChargedMilli: 4200,
    inferenceBalanceCentsRefundedMilli: 95800,
  });
  assert.equal(body.note, undefined);

  assert.deepEqual(messages, ['run started', 'model call completed', 'tool records.query: OK', 'model call completed']);
  assert.deepEqual(values, [1, 2, 3, 4], 'progress values increase');
});

test('agent_run gives a fresh idempotency key to each call, and forwards a caller-supplied one', async () => {
  const keys: unknown[] = [];
  const terminalOnly = () => events([{ ...ev('run.completed'), terminal: true, status: 'COMPLETED' }]);
  const client = agentsClient({
    createRun: (req: unknown, opts: unknown) =>
      createRunReturning(terminalOnly(), undefined, (q) => keys.push((q as Record<string, unknown>)['Idempotency-Key']))(
        req,
        opts,
      ),
  });
  const tool = agentRun({ client, log });
  await tool.handler({ agentId: 'agt_1', input: 'a' }, {});
  await tool.handler({ agentId: 'agt_1', input: 'a' }, {});
  await tool.handler({ agentId: 'agt_1', input: 'a', idempotencyKey: 'retry-7' }, {});
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[2], 'retry-7');
});

test('agent_run budget: maxInferenceCents is sent as the run budget, and a run that reaches it reports BUDGET_EXCEEDED', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const stream = events([
    ev('run.started', {}, 0),
    ev('message.delta', { text: 'Partial answer' }, 1),
    {
      ...ev('run.failed', {}, 2),
      terminal: true,
      status: 'FAILED',
      errorCode: 'BUDGET_EXCEEDED',
      settled: true,
      inferenceBalanceCentsChargedMilli: 25000,
      inferenceBalanceCentsRefundedMilli: 0,
    },
  ]);
  const client = agentsClient({
    createRun: createRunReturning(stream, undefined, (req) => requests.push(req as Record<string, unknown>)),
  });

  const r = await agentRun({ client, log }).handler(
    { agentId: 'agt_1', input: 'Summarize everything', maxInferenceCents: 25, readOnly: true, agentVersion: 2 },
    {},
  );
  assert.deepEqual(requests[0]!.budget, { maxInferenceCents: 25 });
  assert.equal(requests[0]!.readOnly, true);
  assert.equal(requests[0]!.agentVersion, 2);

  // A run that ended on its budget is a completed tool call with a failed run, not a tool error.
  assert.ok(!r.isError);
  const body = parsed(r);
  assert.equal(body.status, 'FAILED');
  assert.equal(body.terminal, true);
  assert.equal(body.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(body.text, 'Partial answer', 'text the run produced before it stopped is kept');
  assert.equal((body.charged as Record<string, unknown>).inferenceBalanceCentsChargedMilli, 25000);
});

test('agent_run budget below the minimum: the 400 BUDGET_TOO_LOW is a tool error and nothing else is called', async () => {
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw apiError(400, { message: 'The budget must be at least 10 cents.', errorCode: 'BUDGET_TOO_LOW' });
      },
    }),
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x', maxInferenceCents: 1 }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /HTTP 400 \(BUDGET_TOO_LOW\)/);
  assert.match(r.content[0]!.text, /at least 10 cents/);
});

test('agent_run without runs:c: the 403 is a tool error and no cancel or read is attempted', async () => {
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw apiError(403, { message: 'Your credential lacks runs:c.', errorCode: 'FORBIDDEN' });
      },
    }),
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /agent_run failed: HTTP 403 \(FORBIDDEN\)/);
});

test('agent_run with a key that already started a run names that run as a result, not an error', async () => {
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw apiError(409, {
          message: 'A run with this key exists.',
          errorCode: 'IDEMPOTENCY_IN_PROGRESS',
          runId: RUN_ID,
          status: 'RUNNING',
        });
      },
    }),
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x', idempotencyKey: 'k1' }, {});
  assert.ok(!r.isError, 'a replay of a started run is not a failure: reporting one invites a second paid run');
  const body = parsed(r);
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.status, 'RUNNING');
  assert.equal(body.alreadyStarted, true);
  assert.match(String(body.note), /run_get/);
});

test('agent_run: a replayed run that already ended is reported terminal, and its text is said to be unrecoverable', async () => {
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw apiError(409, { errorCode: 'IDEMPOTENCY_IN_PROGRESS', runId: RUN_ID, status: 'COMPLETED' });
      },
    }),
  });
  const body = parsed(await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x', idempotencyKey: 'k1' }, {}));
  assert.equal(body.terminal, true);
  assert.match(String(body.note), /cannot be read back/);
});

test('agent_run: a cancel during a replayed key does not cancel the run, which may be another call\'s', async () => {
  const callAbort = new AbortController();
  let cancelCalled = false;
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        callAbort.abort();
        throw apiError(409, { errorCode: 'IDEMPOTENCY_IN_PROGRESS', runId: RUN_ID, status: 'RUNNING' });
      },
    }),
    cancelRun: async () => {
      cancelCalled = true;
      return {};
    },
  });
  const r = await agentRun({ client, log }).handler(
    { agentId: 'agt_1', input: 'x', idempotencyKey: 'k1' },
    { signal: callAbort.signal },
  );
  assert.equal(parsed(r).terminal, false);
  assert.equal(cancelCalled, false);
});

test('agent_run: the replayed run id is read from the 409 header when the body has none', async () => {
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw Object.assign(apiError(409, { errorCode: 'IDEMPOTENCY_IN_PROGRESS' }), {
          rawResponse: { headers: new Headers({ 'X-Vectros-Run-Id': RUN_ID }) },
        });
      },
    }),
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, {});
  assert.ok(!r.isError);
  assert.equal(parsed(r).runId, RUN_ID);
});

test('agent_run: a 409 replay with neither a body runId nor a header is a tool error carrying its errorCode', async () => {
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw apiError(409, { errorCode: 'IDEMPOTENCY_IN_PROGRESS' });
      },
    }),
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x', idempotencyKey: 'k9' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /IDEMPOTENCY_IN_PROGRESS/);
});

test('agent_run: a 409 replay without a status is named, with terminal false and no status', async () => {
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw apiError(409, { errorCode: 'IDEMPOTENCY_IN_PROGRESS', runId: RUN_ID });
      },
    }),
  });
  const body = parsed(await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x', idempotencyKey: 'k9' }, {}));
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.status, undefined);
  assert.equal(body.terminal, false);
});

test('agent_run: a start that fails with no status names the idempotency key to retry with', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = agentsClient({
    createRun: (req: unknown) => {
      requests.push(req as Record<string, unknown>);
      return {
        withRawResponse: async () => {
          throw new TypeError('fetch failed');
        },
      };
    },
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, {});
  assert.equal(r.isError, true);
  const key = String(requests[0]!['Idempotency-Key']);
  assert.ok(r.content[0]!.text.includes(`idempotencyKey: ${key}`), r.content[0]!.text);
  assert.match(r.content[0]!.text, /A run may have started/);
});

test('agent_run: a 5xx start failure names the key; a 4xx refusal (nothing started) does not', async () => {
  const failing = (status: number) =>
    agentsClient({
      createRun: () => ({
        withRawResponse: async () => {
          throw apiError(status, { errorCode: status === 503 ? 'BALANCE_UNAVAILABLE' : 'FORBIDDEN' });
        },
      }),
    });
  const r503 = await agentRun({ client: failing(503), log }).handler({ agentId: 'a', input: 'x', idempotencyKey: 'k5' }, {});
  assert.match(r503.content[0]!.text, /idempotencyKey: k5/);
  const r403 = await agentRun({ client: failing(403), log }).handler({ agentId: 'a', input: 'x', idempotencyKey: 'k4' }, {});
  assert.doesNotMatch(r403.content[0]!.text, /idempotencyKey/);
  const r408 = await agentRun({ client: failing(408), log }).handler({ agentId: 'a', input: 'x', idempotencyKey: 'k8' }, {});
  assert.match(r408.content[0]!.text, /idempotencyKey: k8/, 'a 408 timeout may have started a run');
});

test('agent_run: a cancel before headers, then a start that fails, says the run could not be cancelled and names the key', async () => {
  const callAbort = new AbortController();
  let cancelCalled = false;
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        callAbort.abort();
        throw new TypeError('terminated');
      },
    }),
    cancelRun: async () => {
      cancelCalled = true;
      return {};
    },
  });
  const r = await agentRun({ client, log }).handler(
    { agentId: 'agt_1', input: 'x', idempotencyKey: 'early-1' },
    { signal: callAbort.signal },
  );
  assert.equal(r.isError, true);
  assert.equal(cancelCalled, false, 'no run id was ever known, so nothing could be cancelled');
  assert.match(r.content[0]!.text, /idempotencyKey: early-1/);
  assert.match(r.content[0]!.text, /could not be cancelled/);
});

test('agent_run: any other 409 stays a tool error', async () => {
  const client = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw apiError(409, { message: 'The agent is retired.', errorCode: 'AGENT_RETIRED' });
      },
    }),
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /AGENT_RETIRED/);
});

test('agent_run stops reading at the terminal event even if the connection stays open', async () => {
  let readAfterTerminal = false;
  async function* lingering(): AsyncGenerator<unknown> {
    yield ev('run.started');
    yield { ...ev('run.completed'), terminal: true, status: 'COMPLETED' };
    readAfterTerminal = true;
    yield ev('message.delta', { text: 'must not be read' });
  }
  const client = agentsClient({ createRun: createRunReturning(lingering()) });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, {});
  assert.equal(parsed(r).status, 'COMPLETED');
  assert.equal(readAfterTerminal, false, 'the loop breaks on terminal:true instead of waiting for the close');
});

test('agent_run: a stream that closes without a terminal event returns terminal:false and points at run_get', async () => {
  const client = agentsClient({
    createRun: createRunReturning(events([ev('run.started'), ev('message.delta', { text: 'Half' })])),
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, {});
  assert.ok(!r.isError);
  const body = parsed(r);
  assert.equal(body.terminal, false);
  assert.equal(body.status, 'UNKNOWN', 'no terminal event seen: the status is not known');
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.text, 'Half');
  assert.match(String(body.note), /run_get/);
});

test('agent_run: a stream that breaks off after the run started is not a tool error; the run id is kept', async () => {
  async function* abrupt(): AsyncGenerator<unknown> {
    yield ev('run.started');
    yield ev('tool.completed', { tool: 'records.create', outcome: 'OK' });
    throw new TypeError('terminated');
  }
  // No run-id header: the id comes from the events themselves.
  const client = agentsClient({ createRun: createRunReturning(abrupt(), {}) });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, {});
  assert.ok(!r.isError);
  const body = parsed(r);
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.terminal, false);
  assert.deepEqual(body.toolCalls, [{ tool: 'records.create', outcome: 'OK' }]);
  assert.match(String(body.note), /terminated/);
  assert.match(String(body.note), /run_get/);
});

test('agent_run: when the MCP client cancels the call, the run is cancelled by id and the stream closed', async () => {
  const cancels: unknown[] = [];
  let streamSignal: AbortSignal | undefined;
  const callAbort = new AbortController();
  async function* waitsForAbort(): AsyncGenerator<unknown> {
    yield ev('run.started');
    // The client cancels while the run is working.
    callAbort.abort();
    await new Promise<void>((_, reject) => {
      if (streamSignal?.aborted) reject(new Error('aborted'));
      streamSignal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  const client = agentsClient({
    createRun: createRunReturning(waitsForAbort(), undefined, (_req, opts) => {
      streamSignal = (opts as { abortSignal: AbortSignal }).abortSignal;
    }),
    cancelRun: async (req: unknown) => {
      cancels.push(req);
      return { id: RUN_ID, status: 'RUNNING', terminal: false };
    },
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  assert.deepEqual(cancels, [{ id: RUN_ID }], 'exactly one cancel, for this run');
  assert.equal(streamSignal?.aborted, true, 'the stream is closed');
  const body = parsed(r);
  assert.equal(body.terminal, false);
  assert.match(String(body.note), /cancelled/);
});

test('agent_run: a cancel before any event arrives uses the run id from the response header', async () => {
  const cancels: unknown[] = [];
  let streamSignal: AbortSignal | undefined;
  const callAbort = new AbortController();
  async function* silentUntilAbort(): AsyncGenerator<unknown> {
    callAbort.abort();
    await new Promise<void>((_, reject) => {
      if (streamSignal?.aborted) reject(new Error('aborted'));
      streamSignal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    // Never reached: the stream is closed before any event arrives.
    yield ev('run.started');
  }
  const client = agentsClient({
    createRun: createRunReturning(silentUntilAbort(), { 'X-Vectros-Run-Id': 'feedfeedfeedfeedfeedfeedfeedfeed' }, (_r, opts) => {
      streamSignal = (opts as { abortSignal: AbortSignal }).abortSignal;
    }),
    cancelRun: async (req: unknown) => {
      cancels.push(req);
      return {};
    },
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  assert.deepEqual(cancels, [{ id: 'feedfeedfeedfeedfeedfeedfeedfeed' }]);
  assert.equal(parsed(r).runId, 'feedfeedfeedfeedfeedfeedfeedfeed');
});

test('agent_run: a cancel while the start waits for headers does not abort it; the named run is then cancelled', async () => {
  const cancels: unknown[] = [];
  const callAbort = new AbortController();
  let startSignal: AbortSignal | undefined;
  let releaseHeaders!: () => void;
  const headersArrive = new Promise<void>((resolve) => (releaseHeaders = resolve));
  async function* afterCancel(): AsyncGenerator<unknown> {
    // The stream is closed as soon as the headers name the run.
    if (startSignal?.aborted) throw new Error('aborted');
    yield ev('run.started');
  }
  const client = agentsClient({
    createRun: (_req: unknown, opts: unknown) => {
      startSignal = (opts as { abortSignal: AbortSignal }).abortSignal;
      return {
        withRawResponse: async () => {
          // The platform has started the run; its response headers are still on the way.
          await headersArrive;
          if (startSignal!.aborted) throw new Error('The user aborted a request.');
          return { data: afterCancel(), rawResponse: { headers: new Headers({ 'X-Vectros-Run-Id': RUN_ID }) } };
        },
      };
    },
    cancelRun: async (req: unknown) => {
      cancels.push(req);
      return {};
    },
  });
  const pending = agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  await new Promise((r) => setImmediate(r));
  callAbort.abort();
  assert.equal(startSignal?.aborted, false, 'the start request is not aborted before it names the run');
  releaseHeaders();
  const r = await pending;
  assert.deepEqual(cancels, [{ id: RUN_ID }], 'the run the platform started is cancelled by id');
  assert.equal(startSignal?.aborted, true, 'and the stream is closed');
  const body = parsed(r);
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.terminal, false);
  assert.match(String(body.note), /cancelled/);
});

test('agent_run: a cancel before headers, with no run-id header, waits for the first event to name the run', async () => {
  const cancels: unknown[] = [];
  const callAbort = new AbortController();
  let startSignal: AbortSignal | undefined;
  let readAfterAbort = false;
  async function* named(): AsyncGenerator<unknown> {
    // The stream is not closed before an event names the run.
    assert.equal(startSignal?.aborted, false);
    yield ev('run.started');
    if (startSignal?.aborted) throw new Error('aborted');
    readAfterAbort = true;
    yield ev('message.delta', { text: 'not read' });
  }
  const client = agentsClient({
    createRun: (_req: unknown, opts: unknown) => {
      startSignal = (opts as { abortSignal: AbortSignal }).abortSignal;
      return {
        withRawResponse: async () => {
          callAbort.abort();
          return { data: named(), rawResponse: { headers: new Headers() } };
        },
      };
    },
    cancelRun: async (req: unknown) => {
      cancels.push(req);
      return {};
    },
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  assert.deepEqual(cancels, [{ id: RUN_ID }], 'the run the first event named is cancelled');
  assert.equal(startSignal?.aborted, true);
  assert.equal(readAfterAbort, false, 'and the stream is closed right after');
  assert.equal(parsed(r).runId, RUN_ID);
});

test('agent_run: a cancel mid-stream with no run-id header cancels the id the events named', async () => {
  const cancels: unknown[] = [];
  let streamSignal: AbortSignal | undefined;
  const callAbort = new AbortController();
  async function* named(): AsyncGenerator<unknown> {
    yield ev('run.started');
    callAbort.abort();
    await new Promise<void>((_, reject) => {
      if (streamSignal?.aborted) reject(new Error('aborted'));
      streamSignal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  const client = agentsClient({
    createRun: createRunReturning(named(), {}, (_r, opts) => {
      streamSignal = (opts as { abortSignal: AbortSignal }).abortSignal;
    }),
    cancelRun: async (req: unknown) => {
      cancels.push(req);
      return {};
    },
  });
  await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  assert.deepEqual(cancels, [{ id: RUN_ID }]);
});

test('agent_run: a cancel request that fails still returns the result', async () => {
  let streamSignal: AbortSignal | undefined;
  const callAbort = new AbortController();
  let cancelCalled = false;
  async function* working(): AsyncGenerator<unknown> {
    yield ev('run.started');
    callAbort.abort();
    await new Promise<void>((_, reject) => {
      if (streamSignal?.aborted) reject(new Error('aborted'));
      streamSignal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  const client = agentsClient({
    createRun: createRunReturning(working(), undefined, (_r, opts) => {
      streamSignal = (opts as { abortSignal: AbortSignal }).abortSignal;
    }),
    cancelRun: async () => {
      cancelCalled = true;
      throw apiError(503, { errorCode: 'RUN_UNAVAILABLE' });
    },
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalled, true);
  assert.ok(!r.isError);
  assert.equal(parsed(r).runId, RUN_ID);
});

test('agent_run: a failed progress notification does not end the read of the run', async () => {
  const stream = events([
    ev('run.started'),
    ev('tool.completed', { tool: 'records.query', outcome: 'OK' }),
    ev('message.completed', { text: 'All done.' }),
    { ...ev('run.completed'), terminal: true, status: 'COMPLETED' },
  ]);
  const client = agentsClient({ createRun: createRunReturning(stream) });
  const extra: ToolExtra = {
    _meta: { progressToken: 'tok' },
    sendNotification: async () => {
      throw new Error('transport closed');
    },
  };
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, extra);
  const body = parsed(r);
  assert.equal(body.terminal, true);
  assert.equal(body.status, 'COMPLETED');
  assert.equal(body.text, 'All done.');
  assert.equal(body.note, undefined);
});

test('agent_run: a cancel that arrives as the run finishes sends no cancel for the ended run', async () => {
  const cancels: unknown[] = [];
  const callAbort = new AbortController();
  async function* finishes(): AsyncGenerator<unknown> {
    try {
      yield ev('run.started');
      yield { ...ev('run.completed'), terminal: true, status: 'COMPLETED' };
    } finally {
      // The client's cancel lands while the stream is being closed after the terminal event.
      callAbort.abort();
    }
  }
  const client = agentsClient({
    createRun: createRunReturning(finishes()),
    cancelRun: async (req: unknown) => {
      cancels.push(req);
      return {};
    },
  });
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancels, [], 'a completed run is not cancelled');
  assert.equal(parsed(r).status, 'COMPLETED');
});

test('agent_run: a cancel with the terminal event already read, but no terminal flag on the type, sends nothing', async () => {
  const cancels: unknown[] = [];
  const callAbort = new AbortController();
  async function* finishes(): AsyncGenerator<unknown> {
    try {
      yield ev('run.started');
      yield { type: 'run.failed', runId: RUN_ID, seq: 2, status: 'FAILED', errorCode: 'BUDGET_EXCEEDED' };
    } finally {
      callAbort.abort();
    }
  }
  const client = agentsClient({
    createRun: createRunReturning(finishes()),
    cancelRun: async (req: unknown) => {
      cancels.push(req);
      return {};
    },
  });
  await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancels, []);
});

test('agent_run: a call already cancelled starts no run', async () => {
  const callAbort = new AbortController();
  callAbort.abort();
  const client = agentsClient({}); // createRun absent: calling it would throw
  const r = await agentRun({ client, log }).handler({ agentId: 'agt_1', input: 'x' }, { signal: callAbort.signal });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /cancelled before the run started/);
});

test('agent_list limit: 1 to 100; 0 and 101 are refused', () => {
  const schema = z.object(agentList({ client: {} as never, log }).inputSchema).strict();
  assert.ok(schema.safeParse({ limit: 1 }).success);
  assert.ok(schema.safeParse({ limit: 100 }).success);
  assert.ok(!schema.safeParse({ limit: 0 }).success);
  assert.ok(!schema.safeParse({ limit: 101 }).success);
});

test('the scope each agent tool needs is named in its description', () => {
  const run = agentRun({ client: {} as never, log }).description;
  const get = runGet({ client: {} as never, log }).description;
  const list = agentList({ client: {} as never, log }).description;
  assert.match(run, /runs:c/);
  assert.match(run, /runs:r/, 'agent_run sends the caller to run_get, which needs runs:r');
  assert.match(get, /runs:r/);
  assert.match(get, /runs:c/, 'run_get says runs:c alone does not reach it');
  assert.match(list, /runs:c/);
  assert.match(list, /agents:r/);
});

test('every agent_run note that sends the caller to run_get names runs:r', async () => {
  // Not terminal.
  const open = agentsClient({ createRun: createRunReturning(events([ev('run.started')])) });
  const n1 = String(parsed(await agentRun({ client: open, log }).handler({ agentId: 'a', input: 'x' }, {})).note);
  assert.match(n1, /run_get/);
  assert.match(n1, /runs:r/);
  // Replayed key.
  const replay = agentsClient({
    createRun: () => ({
      withRawResponse: async () => {
        throw apiError(409, { errorCode: 'IDEMPOTENCY_IN_PROGRESS', runId: RUN_ID, status: 'RUNNING' });
      },
    }),
  });
  const n2 = String(parsed(await agentRun({ client: replay, log }).handler({ agentId: 'a', input: 'x', idempotencyKey: 'k' }, {})).note);
  assert.match(n2, /runs:r/);
  // Cancelled call.
  let streamSignal: AbortSignal | undefined;
  const callAbort = new AbortController();
  async function* working(): AsyncGenerator<unknown> {
    yield ev('run.started');
    callAbort.abort();
    await new Promise<void>((_, reject) => {
      if (streamSignal?.aborted) reject(new Error('aborted'));
      streamSignal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  const cancelled = agentsClient({
    createRun: createRunReturning(working(), undefined, (_r, opts) => {
      streamSignal = (opts as { abortSignal: AbortSignal }).abortSignal;
    }),
    cancelRun: async () => ({}),
  });
  const n3 = String(parsed(await agentRun({ client: cancelled, log }).handler({ agentId: 'a', input: 'x' }, { signal: callAbort.signal })).note);
  assert.match(n3, /cancelled/);
  assert.match(n3, /runs:r/);
});

test('agent_list and run_get take no contextId: they act in the context agent_run runs in', () => {
  const list = z.object(agentList({ client: {} as never, log }).inputSchema).strict();
  const get = z.object(runGet({ client: {} as never, log }).inputSchema).strict();
  assert.ok(!list.safeParse({ contextId: 'c' }).success);
  assert.ok(!get.safeParse({ runId: RUN_ID, contextId: 'c' }).success);
});

test('agent_run input limits: empty and over-long input, a bad idempotency key and a zero budget are refused', () => {
  const schema = z.object(agentRun({ client: {} as never, log }).inputSchema).strict();
  assert.ok(schema.safeParse({ agentId: 'a', input: 'x' }).success);
  assert.ok(!schema.safeParse({ agentId: 'a', input: '' }).success);
  assert.ok(!schema.safeParse({ agentId: 'a', input: 'x'.repeat(100_001) }).success);
  // 81,000 characters of a three-byte script (243,000 bytes) is under the character limit but over the byte limit.
  assert.ok(!schema.safeParse({ agentId: 'a', input: '\u4e2d'.repeat(81_000) }).success);
  assert.ok(schema.safeParse({ agentId: 'a', input: '\u4e2d'.repeat(70_000) }).success);
  // 100,000 NUL characters pass the character limit but JSON escapes each to six bytes (\u0000).
  assert.ok(!schema.safeParse({ agentId: 'a', input: '\u0000'.repeat(100_000) }).success);
  assert.ok(schema.safeParse({ agentId: 'a', input: '\u0000'.repeat(39_000) }).success);
  assert.ok(!schema.safeParse({ agentId: 'a', input: 'x', idempotencyKey: 'has space' }).success);
  assert.ok(!schema.safeParse({ agentId: 'a', input: 'x', maxInferenceCents: 0 }).success);
  assert.ok(!schema.safeParse({ agentId: 'a', input: 'x', maxInferenceCents: 2.5 }).success);
  // A run cannot name an app context: the API refuses one on this route.
  assert.ok(!schema.safeParse({ agentId: 'a', input: 'x', contextId: 'c' }).success);
});

test('agent_run is not advertised as a read: a host must confirm it', () => {
  const tool = agentRun({ client: {} as never, log });
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(agentList({ client: {} as never, log }).annotations?.readOnlyHint, true);
  assert.equal(runGet({ client: {} as never, log }).annotations?.readOnlyHint, true);
});

// ============================================================================
// run stream aggregation
// ============================================================================

test('consumeRunStream ignores unknown event types and fields, and ends on an unknown terminal event', async () => {
  const run = await consumeRunStream(
    events([
      ev('run.started'),
      ev('tool.progress', { percent: 40 }),
      ev('message.completed', { text: 'Done.', futureField: 1 }),
      { ...ev('run.expired'), terminal: true, status: 'EXPIRED', errorCode: 'RUN_EXPIRED' },
      ev('message.delta', { text: 'never read' }),
    ]),
  );
  assert.equal(run.terminal, true);
  assert.equal(run.status, 'EXPIRED');
  assert.equal(run.errorCode, 'RUN_EXPIRED');
  assert.equal(run.text, 'Done.');
});

test('consumeRunStream keeps delta text when a completed event carries no text or an empty one', async () => {
  const run = await consumeRunStream(
    events([
      ev('message.delta', { text: 'First ' }),
      ev('message.delta', { text: 'answer.' }),
      ev('message.completed', { text: '' }),
      ev('message.delta', { text: 'Second answer.' }),
      ev('message.completed', {}),
      ev('message.delta', { text: 'Third, cut' }),
      { ...ev('run.failed'), terminal: true, errorCode: 'MODEL_ERROR' },
    ]),
  );
  assert.equal(run.text, 'First answer.\n\nSecond answer.\n\nThird, cut');
  assert.equal(run.status, 'FAILED');
});

test('consumeRunStream ends on terminal:true even on an event type that is not a terminal one', async () => {
  const run = await consumeRunStream(
    events([ev('message.completed', { text: 'x' }), { ...ev('message.delta', { text: 'y' }), terminal: true }, ev('message.delta', { text: 'z' })]),
  );
  assert.equal(run.terminal, true);
  assert.equal(run.status, 'ENDED');
  assert.equal(run.text, 'x\n\ny');
});

test('consumeRunStream ends on a terminal event type even when its terminal flag is missing', async () => {
  let readAfter = false;
  async function* noFlag(): AsyncGenerator<unknown> {
    yield ev('message.completed', { text: 'Done.' });
    yield { type: 'run.completed', runId: RUN_ID, seq: 2, status: 'COMPLETED' };
    readAfter = true;
    yield ev('message.delta', { text: 'never' });
  }
  const run = await consumeRunStream(noFlag());
  assert.equal(run.terminal, true);
  assert.equal(run.status, 'COMPLETED');
  assert.equal(readAfter, false);
});

test('consumeRunStream: an event type named like an object property is not mistaken for a terminal one', async () => {
  const run = await consumeRunStream(events([ev('constructor'), ev('toString'), ev('message.completed', { text: 'ok' })]));
  assert.equal(run.terminal, false);
  assert.equal(run.status, 'UNKNOWN');
  assert.equal(run.text, 'ok');
});

test('consumeRunStream sends a heartbeat while no event arrives', async () => {
  async function* slow(): AsyncGenerator<unknown> {
    yield ev('run.started');
    await new Promise((r) => setTimeout(r, 120));
    yield { ...ev('run.completed'), terminal: true, status: 'COMPLETED' };
  }
  const messages: string[] = [];
  const run = await consumeRunStream(slow(), RUN_ID, (m) => {
    messages.push(m);
  }, 30);
  assert.equal(run.terminal, true);
  assert.ok(messages.includes('run still working'), `heartbeat sent: ${JSON.stringify(messages)}`);
  const after = messages.length;
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(messages.length, after, 'no heartbeat after the stream has been read');
});

test('consumeRunStream names the status from the terminal type when the event carries none', async () => {
  const run = await consumeRunStream(
    events([{ ...ev('run.cancelled'), terminal: true, errorCode: 'CANCELLED_BY_CALLER' }]),
  );
  assert.equal(run.status, 'CANCELLED');
  assert.equal(run.charged, undefined, 'no charge fields, no charged object');
});

test('consumeRunStream throttles text progress to one notification per block of new characters', async () => {
  const deltas = Array.from({ length: 100 }, () => ev('message.delta', { text: 'x'.repeat(10) }));
  const messages: string[] = [];
  const run = await consumeRunStream(
    events([...deltas, { ...ev('run.completed'), terminal: true }]),
    RUN_ID,
    (m) => {
      messages.push(m);
    },
  );
  assert.equal(run.text.length, 1000);
  assert.equal(messages.length, Math.floor(1000 / TEXT_PROGRESS_CHARS), 'not one notification per delta');
});

// ============================================================================
// run_get
// ============================================================================

test('run_get reads one run by id and returns it as the API gives it', async () => {
  const calls: unknown[] = [];
  const run = {
    id: RUN_ID,
    agentId: 'agt_1',
    agentVersion: 3,
    status: 'COMPLETED',
    terminal: true,
    reason: 'end_turn',
    steps: 2,
    toolCalls: [{ toolCallId: 't1', tool: 'records.query', outcome: 'OK' }],
    usage: { inferenceBalanceCentsChargedMilli: 4200, inferenceBalanceCentsRefundedMilli: 95800 },
  };
  const client = agentsClient({
    getRun: async (req: unknown) => {
      calls.push(req);
      return run;
    },
  });
  const r = await runGet({ client, log }).handler({ runId: RUN_ID }, {});
  assert.ok(!r.isError);
  assert.deepEqual(calls[0], { id: RUN_ID });
  assert.deepEqual(parsed(r), run);
});

test('run_get without runs:r, or for a run it cannot see: the API error is a tool error', async () => {
  const client = agentsClient({
    getRun: async () => {
      throw apiError(403, { message: 'Your credential lacks runs:r.', errorCode: 'FORBIDDEN' });
    },
  });
  const r = await runGet({ client, log }).handler({ runId: RUN_ID }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /run_get failed: HTTP 403 \(FORBIDDEN\)/);

  const missing = agentsClient({
    getRun: async () => {
      throw apiError(404, { message: 'No such run.', errorCode: 'RUN_NOT_FOUND' });
    },
  });
  const r2 = await runGet({ client: missing, log }).handler({ runId: RUN_ID }, {});
  assert.equal(r2.isError, true);
  assert.match(r2.content[0]!.text, /HTTP 404/);
});
