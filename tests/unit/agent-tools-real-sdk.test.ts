/**
 * agent_list, agent_run, run_get and document_query through the REAL bundled SDK
 * client, against a local HTTP server that answers like the API.
 *
 * The other tests mock the client, so they cannot see how the generated SDK
 * actually sends a request or decodes the run stream. These pin that: the
 * `Idempotency-Key` header, the run-id response header read through
 * `withRawResponse()`, the Server-Sent Events frames (with keepalive comments)
 * decoded into events, a cancel that closes a live stream and reaches
 * `POST /v1/runs/{id}/cancel`, the 409 replay, a 403 scope refusal, and the
 * document list's `type` query parameter.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { VectrosClient } from '@vectros-ai/sdk';

import agentList from '../../src/tools/agent_list.js';
import agentRun from '../../src/tools/agent_run.js';
import runGet from '../../src/tools/run_get.js';
import documentQuery from '../../src/tools/document_query.js';

const log = pino({ level: 'silent' });
const RUN_ID = 'abcdefabcdefabcdefabcdefabcdef01';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const seen: Seen[] = [];
let server: Server;
let baseUrl = '';
/** How POST /v1/runs answers, per test. */
let runMode: 'complete' | 'hold' | 'replay' | 'forbidden' = 'complete';

function frame(ev: Record<string, unknown>, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: run.event\ndata: ${JSON.stringify(ev)}\n\n`;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/v1/agents') {
        json(res, 200, {
          data: [{ id: 'agt_1', name: 'triage', description: 'd', latestVersion: 2, status: 'ACTIVE', system: 'secret prompt' }],
          nextCursor: null,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/runs/${RUN_ID}`) {
        json(res, 200, { id: RUN_ID, status: 'COMPLETED', terminal: true, steps: 1, toolCalls: [] });
        return;
      }
      if (req.method === 'POST' && url.pathname === `/v1/runs/${RUN_ID}/cancel`) {
        json(res, 202, { id: RUN_ID, status: 'RUNNING', terminal: false });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/documents') {
        json(res, 200, { data: [], nextCursor: 'more' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        if (runMode === 'forbidden') {
          json(res, 403, { message: 'Your credential lacks runs:c.', errorCode: 'FORBIDDEN' });
          return;
        }
        if (runMode === 'replay') {
          json(res, 409, { message: 'A run with this key exists.', errorCode: 'IDEMPOTENCY_IN_PROGRESS', status: 'RUNNING' }, {
            'X-Vectros-Run-Id': RUN_ID,
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Vectros-Run-Id': RUN_ID });
        res.write(': keepalive\n\n');
        res.write(frame({ type: 'run.started', runId: RUN_ID, seq: 0, terminal: false, agentId: 'agt_1', agentVersion: 2 }, 0));
        res.write(frame({ type: 'message.delta', runId: RUN_ID, seq: 1, terminal: false, text: 'Hel' }));
        res.write(': keepalive\n\n');
        res.write(frame({ type: 'message.delta', runId: RUN_ID, seq: 1, terminal: false, text: 'lo.' }));
        if (runMode === 'hold') return; // the run keeps working: the stream stays open
        res.write(frame({ type: 'message.completed', runId: RUN_ID, seq: 1, terminal: false, step: 1, text: 'Hello.' }, 1));
        res.write(
          frame(
            {
              type: 'run.completed',
              runId: RUN_ID,
              seq: 2,
              terminal: true,
              status: 'COMPLETED',
              reason: 'end_turn',
              settled: true,
              inferenceBalanceCentsChargedMilli: 1200,
              inferenceBalanceCentsRefundedMilli: 23800,
            },
            2,
          ),
        );
        res.end();
        return;
      }
      json(res, 404, { message: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(): VectrosClient {
  return new VectrosClient({ token: 'ssk_test_local', environment: baseUrl, maxRetries: 0 });
}

function parsed(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

test('real SDK: agent_run sends the idempotency key, decodes the stream and reads the run-id header', async () => {
  runMode = 'complete';
  seen.length = 0;
  const r = await agentRun({ client: client(), log }).handler(
    { agentId: 'agt_1', input: 'Say hello.', maxInferenceCents: 25, idempotencyKey: 'real-1' },
    {},
  );
  assert.ok(!r.isError, r.content[0]!.text);
  const post = seen.find((s) => s.method === 'POST' && s.url === '/v1/runs')!;
  assert.equal(post.headers['idempotency-key'], 'real-1');
  assert.equal(post.headers.authorization, 'Bearer ssk_test_local');
  assert.deepEqual(JSON.parse(post.body), {
    agentId: 'agt_1',
    input: { text: 'Say hello.' },
    budget: { maxInferenceCents: 25 },
  });
  const body = parsed(r);
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.status, 'COMPLETED');
  assert.equal(body.terminal, true);
  assert.equal(body.text, 'Hello.');
  assert.deepEqual(body.charged, {
    settled: true,
    inferenceBalanceCentsChargedMilli: 1200,
    inferenceBalanceCentsRefundedMilli: 23800,
  });
});

test('real SDK: cancelling during a live stream closes it and cancels the run by id', async () => {
  runMode = 'hold';
  seen.length = 0;
  const callAbort = new AbortController();
  const messages: string[] = [];
  const pending = agentRun({ client: client(), log }).handler(
    { agentId: 'agt_1', input: 'Take your time.' },
    {
      signal: callAbort.signal,
      _meta: { progressToken: 'p' },
      sendNotification: async (n) => {
        messages.push(n.params.message ?? '');
        if (n.params.message === 'run started') setTimeout(() => callAbort.abort(), 20);
      },
    },
  );
  const r = await pending;
  const body = parsed(r);
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.terminal, false);
  assert.match(String(body.note), /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    seen.some((s) => s.method === 'POST' && s.url === `/v1/runs/${RUN_ID}/cancel`),
    'the cancel reached the API',
  );
});

test('real SDK: a 409 replay is read from the error body and the response header', async () => {
  runMode = 'replay';
  const r = await agentRun({ client: client(), log }).handler({ agentId: 'agt_1', input: 'x', idempotencyKey: 'k' }, {});
  assert.ok(!r.isError, r.content[0]!.text);
  const body = parsed(r);
  assert.equal(body.runId, RUN_ID, 'the id comes from the X-Vectros-Run-Id header the SDK error carries');
  assert.equal(body.status, 'RUNNING');
  assert.equal(body.alreadyStarted, true);
});

test('real SDK: a 403 scope refusal is a tool error with its errorCode', async () => {
  runMode = 'forbidden';
  const r = await agentRun({ client: client(), log }).handler({ agentId: 'agt_1', input: 'x' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /HTTP 403 \(FORBIDDEN\)/);
  assert.doesNotMatch(r.content[0]!.text, /idempotencyKey/, 'a clear refusal started nothing, so no key is offered');
});

test('real SDK: agent_list and run_get', async () => {
  seen.length = 0;
  const list = parsed(await agentList({ client: client(), log }).handler({}, {}));
  assert.deepEqual(list.data, [{ id: 'agt_1', name: 'triage', description: 'd', latestVersion: 2, status: 'ACTIVE' }]);
  assert.match(seen[0]!.url, /^\/v1\/agents\?.*limit=10/);
  const run = parsed(await runGet({ client: client(), log }).handler({ runId: RUN_ID }, {}));
  assert.equal(run.status, 'COMPLETED');
  assert.equal(seen[1]!.url, `/v1/runs/${RUN_ID}`);
});

test('real SDK: document_query list mode puts `type` on the query string', async () => {
  seen.length = 0;
  const r = await documentQuery({ client: client(), log }).handler({ type: 'invoice', folderId: 'fld_1' }, {});
  assert.ok(!r.isError, r.content[0]!.text);
  const url = new URL(seen[0]!.url, 'http://localhost');
  assert.equal(url.pathname, '/v1/documents');
  assert.equal(url.searchParams.get('type'), 'invoice');
  assert.equal(url.searchParams.get('folderId'), 'fld_1');
});
