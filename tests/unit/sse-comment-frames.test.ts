/**
 * Comment-frame tolerance, end to end through the real SDK.
 *
 * The streaming inference routes may interleave SSE comment lines (a line that
 * starts with a colon) with events. Per the SSE specification a comment never
 * dispatches an event, and every reader we ship must ignore it. `consumeStream`
 * itself never sees bytes — it consumes the SDK's decoded iterable — so the
 * meaningful test drives the REAL SDK stream reader with a byte stream that
 * contains comment frames and asserts the aggregated result is identical to
 * the same stream without them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VectrosClient } from '@vectros-ai/sdk';

import { consumeStream, type SseEvent } from '../../src/sse.js';

const COMMENT = ': keepalive\n\n';

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, event: type, ...payload })}\n\n`;
}

const DONE = {
  inputTokens: 11,
  outputTokens: 7,
  model: 'm',
  platformCreditsCharged: 0,
  inferenceBalanceCentsCharged: 0,
};

const RESULTS_FRAME = frame('search_results', { results: [], totalResults: 0, searchTimeMs: 3 });
const HELLO_FRAME = frame('content_delta', { delta: 'Hello, ' });
const WORLD_FRAME = frame('content_delta', { delta: 'world' });
const DONE_FRAME = frame('done', DONE);

const EVENT_FRAMES: string[] = [RESULTS_FRAME, HELLO_FRAME, WORLD_FRAME, DONE_FRAME];

/** Comment frames before the first event, between events and right before `done`. */
const WITH_COMMENTS: string[] = [
  COMMENT,
  RESULTS_FRAME,
  COMMENT,
  HELLO_FRAME,
  COMMENT,
  COMMENT,
  WORLD_FRAME,
  COMMENT,
  DONE_FRAME,
];

async function serve(chunks: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const c of chunks) res.write(c);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function aggregate(chunks: string[]) {
  const { server, url } = await serve(chunks);
  try {
    const client = new VectrosClient({ token: 'sk_test', environment: url, baseUrl: url, maxRetries: 0 });
    const stream = await client.inference.ragInference({ query: 'q' } as never);
    return await consumeStream(stream as unknown as AsyncIterable<SseEvent>);
  } finally {
    server.close();
  }
}

/**
 * The same stream delivered through an injected `fetch`, one body read per `pieces` entry. This pins the chunk
 * boundaries exactly (a socket may coalesce writes), so a comment line split at any byte is really seen split.
 */
async function aggregateInPieces(pieces: string[]) {
  const enc = new TextEncoder();
  const fetchStub = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const p of pieces) controller.enqueue(enc.encode(p));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
  const client = new VectrosClient({
    token: 'sk_test',
    environment: 'http://stub.invalid',
    baseUrl: 'http://stub.invalid',
    maxRetries: 0,
    fetch: fetchStub,
  });
  const stream = await client.inference.ragInference({ query: 'q' } as never);
  return consumeStream(stream as unknown as AsyncIterable<SseEvent>);
}

function inPiecesOf(size: number, text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

test('real SDK + consumeStream: comment frames leave the aggregated result unchanged', async () => {
  const baseline = await aggregate(EVENT_FRAMES);
  const withComments = await aggregate(WITH_COMMENTS);
  assert.equal(baseline.answer, 'Hello, world');
  assert.deepEqual(withComments, baseline);
});

test('real SDK + consumeStream: comment frames split across reads at any byte are still ignored', async () => {
  const baseline = await aggregate(EVENT_FRAMES);
  const wire = WITH_COMMENTS.join('');
  // size 1 puts the colon, the text and each newline of a comment in separate reads; 13 is the comment's own length
  for (const size of [1, 2, 3, 7, 13]) {
    assert.deepEqual(await aggregateInPieces(inPiecesOf(size, wire)), baseline, `read size ${size}`);
  }
  // the blank line that ends a comment arriving on its own, after the comment text
  assert.deepEqual(
    await aggregateInPieces([': keepalive\n', '\n', ...EVENT_FRAMES.slice(0, 2), ': keep', 'alive\n\n', ...EVENT_FRAMES.slice(2)]),
    baseline,
  );
});

test('real SDK + consumeStream: a stream that is only comments and a done event completes', async () => {
  const result = await aggregate([COMMENT, COMMENT, frame('done', DONE)]);
  assert.equal(result.answer, '');
  assert.equal(result.usage?.inputTokens, 11);
});
