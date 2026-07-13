/**
 * Wire-level pin for the ownership-scope contract.
 *
 * The tool tests use a mock client, which cannot prove the pinned SDK actually
 * SERIALIZES the ownership signal onto the wire. The load-bearing distinction is
 * `scopes: []` (the caller-only PRIVATE tier) vs. `scopes` omitted (default
 * identity ownership). If the SDK pruned an empty array, a "private" create would
 * silently be stamped with the credential's full identity — a tenant-visibility
 * regression no mock catches. This constructs the REAL SDK client over a stubbed
 * fetch and asserts the exact bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VectrosClient } from '@vectros-ai/sdk';

/** Run one createRecord through the real SDK and return the serialized request body. */
async function capturedBody(scopes?: string[]): Promise<string> {
  const orig = globalThis.fetch;
  let body = '';
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    body = init?.body != null ? String(init.body) : '';
    return new Response(JSON.stringify({ id: 'x', externalId: 'probe', scopes: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = new VectrosClient({ token: 'ssk_live_test', environment: 'https://api.staging.vectros.ai' });
    const req: Record<string, unknown> = {
      typeName: 'memory',
      externalId: 'probe',
      payload: { title: 't', body: 'b', kind: 'project' },
    };
    if (scopes !== undefined) req.scopes = scopes;
    await client.records.createRecord({ body: req } as never).catch(() => {});
  } finally {
    globalThis.fetch = orig;
  }
  return body;
}

test('scopes:[] (private tier) is serialized on the wire, NOT pruned as empty', async () => {
  const body = await capturedBody([]);
  assert.ok(body.includes('"scopes":[]'), `expected "scopes":[] on the wire, got: ${body}`);
});

test('scopes omitted sends NO scopes key (default identity ownership) — distinct from []', async () => {
  const body = await capturedBody(undefined);
  assert.ok(!body.includes('"scopes"'), `expected no scopes key when omitted, got: ${body}`);
});

test('a populated scopes array is carried verbatim', async () => {
  const body = await capturedBody(['group:eng']);
  assert.ok(body.includes('"scopes":["group:eng"]'), `expected the scope value on the wire, got: ${body}`);
});
