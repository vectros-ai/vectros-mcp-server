/**
 * Progress-notification emission tests.
 *
 * This is the load-bearing architectural rule. The smoke test
 * verifies "the tool completes within 90s" as a proxy — but the
 * proxy is loose. Here we directly assert:
 *
 *   - rag_ask + document_ask emit one notifications/progress per
 *     SSE content_delta
 *   - The progress payload shape matches MCP spec:
 *       method: 'notifications/progress'
 *       params: { progressToken, progress, message }
 *   - progressToken is gated correctly:
 *       - present → emissions fire
 *       - missing → ZERO emissions (don't trip clients that don't
 *         expect unsolicited progress)
 *       - sendNotification missing → ZERO emissions (no crash)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';

import ragAsk from '../../src/tools/rag_ask.js';
import documentAsk from '../../src/tools/document_ask.js';

const log = pino({ level: 'silent' });

async function* threeDeltaStream() {
  yield { event: 'search_results' as const };
  yield { event: 'content_delta' as const, delta: 'Hello ' };
  yield { event: 'content_delta' as const, delta: 'long ' };
  yield { event: 'content_delta' as const, delta: 'answer' };
  yield { event: 'done' as const };
}

async function* twoDeltaAskStream() {
  yield { event: 'document_context' as const };
  yield { event: 'content_delta' as const, delta: 'A' };
  yield { event: 'content_delta' as const, delta: 'B' };
  yield { event: 'done' as const };
}

function captureNotifications() {
  const received: Array<Record<string, unknown>> = [];
  return {
    received,
    sendNotification: async (n: Record<string, unknown>) => {
      received.push(n);
    },
  };
}

test('rag_ask emits one notifications/progress per content_delta', async () => {
  const cap = captureNotifications();
  const client = {
    inference: { ragInference: async () => threeDeltaStream() },
  } as never;
  const tool = ragAsk({ client, log });
  await tool.handler(
    { query: 'q' },
    { _meta: { progressToken: 'tok-1' }, sendNotification: cap.sendNotification },
  );
  assert.equal(cap.received.length, 3, 'one per content_delta — search_results + done do not emit');
  for (const n of cap.received) {
    assert.equal(n.method, 'notifications/progress', 'MCP-spec method name');
  }
  const params0 = cap.received[0].params as Record<string, unknown>;
  assert.equal(params0.progressToken, 'tok-1', 'progressToken passes through');
  assert.equal(params0.message, 'Hello ', 'first chunk text');
  assert.equal(params0.progress, 6, 'running cumulative length');
  const params2 = cap.received[2].params as Record<string, unknown>;
  assert.equal(params2.message, 'answer');
  assert.equal(params2.progress, 17, 'cumulative length after all 3 chunks');
});

test('document_ask emits one notifications/progress per content_delta', async () => {
  const cap = captureNotifications();
  const client = {
    inference: { documentAsk: async () => twoDeltaAskStream() },
  } as never;
  const tool = documentAsk({ client, log });
  await tool.handler(
    { documentId: 'd1', prompt: 'p' },
    { _meta: { progressToken: 'tok-2' }, sendNotification: cap.sendNotification },
  );
  assert.equal(cap.received.length, 2);
  const params0 = cap.received[0].params as Record<string, unknown>;
  assert.equal(params0.progressToken, 'tok-2');
});

test('rag_ask emits NO progress when progressToken is missing', async () => {
  const cap = captureNotifications();
  const client = {
    inference: { ragInference: async () => threeDeltaStream() },
  } as never;
  const tool = ragAsk({ client, log });
  // No _meta — client doesn't want progress.
  await tool.handler({ query: 'q' }, { sendNotification: cap.sendNotification });
  assert.equal(
    cap.received.length,
    0,
    'no progressToken → no notifications, even though sendNotification is available',
  );
});

test('rag_ask emits NO progress when sendNotification is missing', async () => {
  const client = {
    inference: { ragInference: async () => threeDeltaStream() },
  } as never;
  const tool = ragAsk({ client, log });
  // Has token but no sendNotification — must not crash, must not throw.
  const r = await tool.handler({ query: 'q' }, { _meta: { progressToken: 'tok-3' } });
  assert.ok(!r.isError, 'still returns clean tool result');
});

test('document_ask emits NO progress when progressToken is missing', async () => {
  const cap = captureNotifications();
  const client = {
    inference: { documentAsk: async () => twoDeltaAskStream() },
  } as never;
  const tool = documentAsk({ client, log });
  await tool.handler(
    { documentId: 'd1', prompt: 'p' },
    { sendNotification: cap.sendNotification },
  );
  assert.equal(cap.received.length, 0);
});

test('hybrid_search and record_query do NOT take a progress callback', async () => {
  // Sanity check: search and record tools are short-running; they
  // should not emit progress even if the client supplies a token.
  const cap = captureNotifications();
  const sClient = {
    search: { content: async () => ({ results: [], searchTimeMs: 0, totalResults: 0 }) },
  } as never;
  const { default: hybridSearch } = await import('../../src/tools/hybrid_search.js');
  const sTool = hybridSearch({ client: sClient, log });
  await sTool.handler(
    { query: 'q' },
    { _meta: { progressToken: 'tok-x' }, sendNotification: cap.sendNotification },
  );
  assert.equal(cap.received.length, 0, 'hybrid_search emits no progress');

  const rClient = {
    records: { listRecords: async () => ({ data: [], nextCursor: null }) },
  } as never;
  const { default: recordQuery } = await import('../../src/tools/record_query.js');
  const rTool = recordQuery({ client: rClient, log });
  await rTool.handler(
    { type: 'patient' },
    { _meta: { progressToken: 'tok-y' }, sendNotification: cap.sendNotification },
  );
  assert.equal(cap.received.length, 0, 'record_query emits no progress');
});
