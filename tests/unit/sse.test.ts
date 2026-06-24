import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeStream, StreamError, type SseEvent } from '../../src/sse.js';

async function* gen(...events: SseEvent[]): AsyncIterable<SseEvent> {
  for (const e of events) yield e;
}

test('consumeStream aggregates content_delta events', async () => {
  const stream = gen(
    { event: 'content_delta', delta: 'Hello, ' },
    { event: 'content_delta', delta: 'world!' },
    // SDK 0.23: `done` carries flat token fields, not a nested `usage`.
    { event: 'done', inputTokens: 10, outputTokens: 5, model: 'claude-haiku-4-5' },
  );
  const result = await consumeStream(stream);
  assert.equal(result.answer, 'Hello, world!');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, model: 'claude-haiku-4-5' });
});

test('consumeStream captures search_results', async () => {
  const stream = gen(
    { event: 'search_results', hits: [{ id: 'doc-1' }] },
    { event: 'content_delta', delta: 'Answer.' },
    { event: 'done' },
  );
  const result = await consumeStream(stream);
  assert.equal(result.answer, 'Answer.');
  assert.deepEqual(result.searchResults, { hits: [{ id: 'doc-1' }] });
});

test('consumeStream captures document_context', async () => {
  const stream = gen(
    { event: 'document_context', documentId: 'doc-1', chunks: 3 },
    { event: 'content_delta', delta: 'A.' },
    { event: 'done' },
  );
  const result = await consumeStream(stream);
  assert.deepEqual(result.documentContext, { documentId: 'doc-1', chunks: 3 });
});

test('consumeStream captures truncation_warning', async () => {
  const stream = gen(
    { event: 'content_delta', delta: 'partial' },
    { event: 'truncation_warning', reason: 'maxTokens' },
    { event: 'done' },
  );
  const result = await consumeStream(stream);
  assert.deepEqual(result.truncationWarning, { reason: 'maxTokens' });
});

test('consumeStream throws StreamError on error event', async () => {
  // Fresh generators per assertion — `gen()` returns a one-shot iterator
  // that the first consumeStream call exhausts.
  const makeStream = () =>
    gen(
      { event: 'content_delta', delta: 'partial' },
      { event: 'error', message: 'upstream blew up' },
    );
  await assert.rejects(consumeStream(makeStream()), StreamError);
  await assert.rejects(consumeStream(makeStream()), /upstream blew up/);
});

test('consumeStream emits progress per content_delta', async () => {
  const stream = gen(
    { event: 'content_delta', delta: 'Hello ' },
    { event: 'content_delta', delta: 'there' },
    { event: 'done' },
  );
  const progressEvents: Array<{ text: string; total: number }> = [];
  const result = await consumeStream(stream, async (chunk) => {
    progressEvents.push(chunk);
  });
  assert.equal(result.answer, 'Hello there');
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents[0].text, 'Hello ');
  assert.equal(progressEvents[0].total, 6);
  assert.equal(progressEvents[1].text, 'there');
  assert.equal(progressEvents[1].total, 11);
});

test('consumeStream handles empty stream', async () => {
  const stream = gen();
  const result = await consumeStream(stream);
  assert.equal(result.answer, '');
  assert.equal(result.usage, undefined);
});
