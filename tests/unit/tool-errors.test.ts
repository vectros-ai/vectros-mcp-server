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

// 0.36.0: the SDK maps every 4xx/5xx to a VectrosError whose `.message` is only
// the error class name; the actionable server text + typed `errorCode` + `requestId`
// live in the parsed `.body`. toolError must prefer the body.
test('toolError prefers the parsed body message over the class-name message', () => {
  const err = new Error('PaymentRequiredError') as Error & {
    statusCode: number;
    body: unknown;
  };
  err.statusCode = 402;
  err.body = {
    message: 'Your pre-paid balance is exhausted. Top it up to continue.',
    errorCode: 'INSUFFICIENT_BALANCE',
    requestId: 'req_abc123',
  };
  const r = toolError('rag_ask', err);
  // The human-readable server reason, not "PaymentRequiredError".
  assert.match(r.content[0].text, /pre-paid balance is exhausted/);
  assert.doesNotMatch(r.content[0].text, /PaymentRequiredError/);
  // The typed code an agent branches on, in both the summary and a trailer line.
  assert.match(r.content[0].text, /HTTP 402 \(INSUFFICIENT_BALANCE\)/);
  assert.match(r.content[0].text, /errorCode: INSUFFICIENT_BALANCE/);
  // The correlation id to quote to support.
  assert.match(r.content[0].text, /requestId: req_abc123/);
});

test('toolError distinguishes the two inference 402 codes for branching', () => {
  const mk = (errorCode: string) => {
    const e = new Error('PaymentRequiredError') as Error & { statusCode: number; body: unknown };
    e.statusCode = 402;
    e.body = { message: 'plan cap reached', errorCode };
    return e;
  };
  assert.match(toolError('rag_ask', mk('SUBSCRIPTION_LIMIT_EXCEEDED')).content[0].text, /SUBSCRIPTION_LIMIT_EXCEEDED/);
  assert.match(toolError('rag_ask', mk('INSUFFICIENT_BALANCE')).content[0].text, /INSUFFICIENT_BALANCE/);
});

test('toolError surfaces a placement/identity 403 body (errorCode + requestId)', () => {
  const err = new Error('ForbiddenError') as Error & { statusCode: number; body: unknown };
  err.statusCode = 403;
  err.body = {
    message: 'scopes includes a namespace your credential is not scoped for: group:secret',
    requestId: 'req_zzz',
  };
  const r = toolError('record_update', err);
  assert.match(r.content[0].text, /not scoped for: group:secret/);
  assert.match(r.content[0].text, /requestId: req_zzz/);
  // No errorCode line when the body carries none.
  assert.doesNotMatch(r.content[0].text, /errorCode:/);
});

test('toolError falls back to e.message when the body carries no message', () => {
  const err = new Error('the real message') as Error & { statusCode: number; body: unknown };
  err.statusCode = 400;
  err.body = { errorCode: 'BAD_NUMBER' };
  const r = toolError('record_create', err);
  assert.match(r.content[0].text, /the real message/);
  assert.match(r.content[0].text, /errorCode: BAD_NUMBER/);
});

test('toolError emits the errorCode trailer even when statusCode is absent', () => {
  // No statusCode → the summary falls to the error-name branch, but the typed
  // code an agent branches on must still surface on its own trailer line.
  class DomainError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'DomainError';
    }
  }
  const err = Object.assign(new DomainError('DomainError'), {
    body: { message: 'placement denied for namespace group:secret', errorCode: 'FORBIDDEN_PLACEMENT' },
  });
  const r = toolError('record_update', err);
  assert.match(r.content[0].text, /record_update failed: DomainError/);
  assert.match(r.content[0].text, /placement denied for namespace group:secret/);
  assert.match(r.content[0].text, /errorCode: FORBIDDEN_PLACEMENT/);
});

test('toolError treats a non-object / empty body defensively (no throw, falls back to message)', () => {
  // The SDK body is typed `unknown`; a string / array / null / whitespace-only
  // message must never throw the formatter and must not manufacture trailer lines.
  for (const body of ['oops', 42, ['a', 'b'], null, { message: '   ' }] as unknown[]) {
    const err = Object.assign(new Error('fallback detail'), { statusCode: 500, body });
    const r = toolError('hybrid_search', err);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /fallback detail/); // e.message, since body yields no usable message
    assert.doesNotMatch(r.content[0].text, /errorCode:/);
    assert.doesNotMatch(r.content[0].text, /requestId:/);
  }
});
