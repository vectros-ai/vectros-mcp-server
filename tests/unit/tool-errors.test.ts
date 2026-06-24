/**
 * toolError() formatting tests.
 *
 * Errors are the highest-stakes UX — they're what partners see when
 * an integration fails. The formatter has to:
 *   - Set isError: true (so the MCP client doesn't treat the error
 *     as a successful tool result)
 *   - Surface the statusCode from a VectrosError-shaped error
 *   - Include the doc pointer URL when one is provided
 *   - Fall back gracefully when err is not an Error instance
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toolError } from '../../src/tools/errors.js';
import { StreamError } from '../../src/sse.js';

test('toolError sets isError:true and returns text content', () => {
  const r = toolError('hybrid_search', new Error('whoops'));
  assert.equal(r.isError, true);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'text');
  assert.match(r.content[0].text, /hybrid_search failed/);
  assert.match(r.content[0].text, /whoops/);
});

test('toolError surfaces statusCode from VectrosError-shape errors', () => {
  const err = new Error('document too big') as Error & { statusCode: number };
  err.statusCode = 413;
  const r = toolError('document_ask', err);
  assert.match(r.content[0].text, /HTTP 413/);
  assert.match(r.content[0].text, /document too big/);
});

test('toolError surfaces error name for non-VectrosError throwables', () => {
  class WeirdError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'WeirdError';
    }
  }
  const r = toolError('rag_ask', new WeirdError('something happened'));
  assert.match(r.content[0].text, /WeirdError/);
  assert.match(r.content[0].text, /something happened/);
});

test('toolError uses "stream error" summary for StreamError', () => {
  const r = toolError('rag_ask', new StreamError('upstream blew up'));
  assert.match(r.content[0].text, /rag_ask stream error/);
  assert.match(r.content[0].text, /upstream blew up/);
});

test('toolError appends doc pointer when provided', () => {
  const r = toolError(
    'rag_ask',
    new Error('quota'),
    'https://docs.vectros.ai/billing#quota',
  );
  assert.match(r.content[0].text, /See: https:\/\/docs\.vectros\.ai\/billing#quota/);
});

test('toolError omits doc-pointer line when none provided', () => {
  const r = toolError('hybrid_search', new Error('x'));
  assert.doesNotMatch(r.content[0].text, /See: /);
});

test('toolError handles non-Error throwables (strings, objects)', () => {
  const r1 = toolError('hybrid_search', 'plain string thrown');
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /plain string thrown/);

  const r2 = toolError('hybrid_search', { code: 'X', custom: true });
  assert.equal(r2.isError, true);
  // Default String() rendering for objects.
  assert.match(r2.content[0].text, /\[object Object\]/);
});
