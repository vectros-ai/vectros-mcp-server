/**
 * Resource handler tests with a mocked Vectros SDK client.
 *
 * Mirror of tools-handlers.test.ts for the resource registry. Each
 * resource is a thin shim — schemas wraps listSchemas, identity
 * delegates to resolveIdentity (shared helper) — so the tests focus
 * on shape compliance + delegation correctness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';

import schemasResource from '../../src/resources/schemas.js';
import identityResource from '../../src/resources/identity.js';
import { ALL_RESOURCE_FACTORIES, RESOURCE_NAMES } from '../../src/resources/index.js';

const log = pino({ level: 'silent' });

// ============================================================================
// Registry shape
// ============================================================================

test('RESOURCE_NAMES + ALL_RESOURCE_FACTORIES stay in lockstep', () => {
  // Every name in the type union has a factory. The server iterates
  // the union and an unimplemented name would throw at construction.
  for (const name of RESOURCE_NAMES) {
    assert.ok(
      typeof ALL_RESOURCE_FACTORIES[name] === 'function',
      `factory for ${name} is registered`,
    );
  }
  assert.equal(
    Object.keys(ALL_RESOURCE_FACTORIES).sort().join(','),
    [...RESOURCE_NAMES].sort().join(','),
    'no orphan factories (entries in factories but not in RESOURCE_NAMES)',
  );
});

test('every resource has the MCP-required fields', () => {
  for (const name of RESOURCE_NAMES) {
    const r = ALL_RESOURCE_FACTORIES[name]({ client: {} as never, log });
    assert.ok(r.name, `${name}: name`);
    assert.ok(r.uri.startsWith('vectros://'), `${name}: uri uses vectros:// scheme`);
    assert.ok(r.title, `${name}: title`);
    assert.ok(r.description.length > 20, `${name}: substantive description`);
    assert.ok(r.mimeType, `${name}: mimeType`);
    assert.equal(typeof r.read, 'function', `${name}: read() function`);
  }
});

// ============================================================================
// schemas resource
// ============================================================================

test('schemas resource calls client.schemas.listSchemas with no filter + unwraps the envelope', async () => {
  const seenArgs: Array<{ userId?: string; orgId?: string; startFrom?: string }> = [];
  const client = {
    schemas: {
      // SDK 0.23: listSchemas returns the { data, nextCursor } envelope; the
      // resource drains it (no ownership filters — always-everything).
      listSchemas: async (args: { userId?: string; orgId?: string; startFrom?: string }) => {
        seenArgs.push(args);
        return { data: [{ id: 'sch_1', typeName: 'patient' }], nextCursor: null };
      },
    },
  } as never;
  const r = schemasResource({ client, log });
  assert.equal(r.uri, 'vectros://schemas');
  assert.equal(r.mimeType, 'application/json');

  const text = await r.read();
  assert.equal(seenArgs.length, 1, 'single page → one call');
  assert.equal(seenArgs[0].userId, undefined, 'no userId filter');
  assert.equal(seenArgs[0].orgId, undefined, 'no orgId filter');
  // Body is the unwrapped bare array (lockstep with the list_schemas tool).
  const parsed = JSON.parse(text) as unknown[];
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
});

test('schemas resource propagates SDK errors (resources use protocol errors)', async () => {
  const client = {
    schemas: {
      listSchemas: async () => {
        throw new Error('upstream 503');
      },
    },
  } as never;
  const r = schemasResource({ client, log });
  // Unlike tools (which catch + return isError:true), resources let
  // errors propagate so the MCP SDK converts them to JSON-RPC errors.
  await assert.rejects(() => r.read(), /upstream 503/);
});

// ============================================================================
// identity resource
// ============================================================================

test('identity resource returns derived-only when apiKey/env absent', async () => {
  const r = identityResource({ client: {} as never, log });
  assert.equal(r.uri, 'vectros://identity');
  assert.equal(r.mimeType, 'application/json');

  const text = await r.read();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.environment, undefined);
  assert.equal(parsed.principalType, undefined);
});

test('identity resource delegates to shared helper (uses fetch /v1/ping)', async () => {
  // Verifies that the resource uses the same code path as
  // current_identity tool — both share resolveIdentity().
  const fetchCalls: Array<{ url: string }> = [];
  const originalFetch = globalThis.fetch;
  // @ts-expect-error — test override.
  globalThis.fetch = async (input: string) => {
    fetchCalls.push({ url: String(input) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tenantId: 't_x', environment: 'staging' }),
    } as Response;
  };

  try {
    const r = identityResource({
      client: {} as never,
      log,
      apiKey: 'ssk_live_x',
      environment: 'https://api.staging.vectros.ai',
    });
    const text = await r.read();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(parsed.tenantId, 't_x');
    assert.equal(parsed.environment, 'staging');
    assert.equal(parsed.principalType, 'scoped_key', 'derived from ssk_ prefix');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://api.staging.vectros.ai/v1/ping');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('identity resource propagates ping HTTP errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => 'Bad credential',
  }) as Response;

  try {
    const r = identityResource({
      client: {} as never,
      log,
      apiKey: 'ssk_live_bad',
      environment: 'https://api.staging.vectros.ai',
    });
    await assert.rejects(() => r.read(), /401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
