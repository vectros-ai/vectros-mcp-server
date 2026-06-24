/**
 * CJS-format compatibility test.
 *
 * tsup emits both ESM (dist/index.mjs) and CJS (dist/index.js).
 * Smoke tests + integration spawn the ESM CLI; if a top-level await
 * or an ESM-only transitive dep sneaks into the build, CJS consumers
 * break silently. This test verifies that:
 *
 *   - dist/index.js loads as a CommonJS module
 *   - Public exports (VectrosMCPServer, createStdioTransport,
 *     createLogger, TOOL_NAMES) are present
 *
 * Done via `node -e require(...)` in a subprocess to ensure we're
 * exercising the real CJS loader, not an ESM-interop fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CJS_PATH = resolve(__dirname, '../../dist/index.js').replace(/\\/g, '/');

test('dist/index.js loads via CommonJS require()', () => {
  const script = `
    const mod = require('${CJS_PATH}');
    const out = {
      hasVectrosMCPServer: typeof mod.VectrosMCPServer === 'function',
      hasCreateStdioTransport: typeof mod.createStdioTransport === 'function',
      hasCreateLogger: typeof mod.createLogger === 'function',
      hasToolNames: Array.isArray(mod.TOOL_NAMES),
      toolCount: (mod.TOOL_NAMES || []).length,
      hasResourceNames: Array.isArray(mod.RESOURCE_NAMES),
      resourceCount: (mod.RESOURCE_NAMES || []).length,
      hasInvalidApiKeyError: typeof mod.InvalidApiKeyError === 'function',
    };
    process.stdout.write(JSON.stringify(out));
  `;
  const raw = execFileSync('node', ['-e', script], { encoding: 'utf8' });
  const out = JSON.parse(raw);
  assert.equal(out.hasVectrosMCPServer, true, 'VectrosMCPServer class exported');
  assert.equal(out.hasCreateStdioTransport, true, 'createStdioTransport exported');
  assert.equal(out.hasCreateLogger, true, 'createLogger exported');
  assert.equal(out.hasToolNames, true, 'TOOL_NAMES array exported');
  // Tool count grows as v0.2 tools land — keep in lockstep with
  // src/tools/index.ts ALL_TOOL_FACTORIES.
  assert.equal(out.toolCount, 21, 'TOOL_NAMES = v0.2 eight + records-I/O tier (4) + tier-2 document_query + tier-3 document_update/delete + folder CRUD (6) + parity sweep (lookup_principal, version_history)');
  assert.equal(out.hasResourceNames, true, 'RESOURCE_NAMES array exported (v0.2+)');
  assert.equal(out.resourceCount, 2, 'RESOURCE_NAMES has schemas + identity');
  assert.equal(out.hasInvalidApiKeyError, true, 'InvalidApiKeyError class exported');
});

test('dist/index.js exposes correct TOOL_NAMES via CJS', () => {
  const script = `
    const mod = require('${CJS_PATH}');
    process.stdout.write(JSON.stringify([...mod.TOOL_NAMES].sort()));
  `;
  const raw = execFileSync('node', ['-e', script], { encoding: 'utf8' });
  const names = JSON.parse(raw) as string[];
  assert.deepEqual(
    names,
    [
      // v0.1
      'document_ask',
      'hybrid_search',
      'rag_ask',
      'record_query',
      // v0.2
      'list_schemas',
      'document_get',
      'current_identity',
      'document_ingest',
      // launch data-plane I/O (tier 1)
      'record_get',
      'record_create',
      'record_update',
      'record_delete',
      // launch data-plane I/O (tier 2)
      'document_query',
      // launch data-plane I/O (tier 3)
      'document_update',
      'document_delete',
      'folder_query',
      'folder_create',
      'folder_update',
      'folder_delete',
      // parity sweep
      'lookup_principal',
      'version_history',
    ].sort(),
  );
});
