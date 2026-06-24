/**
 * parseToolsEnv unit tests — VECTROS_MCP_TOOLS CSV parser.
 *
 * The CLI extracts this into a pure function so we can test it
 * without spawning the server. Bad input is a fail-fast condition
 * at startup (the CLI maps the throw to process.exit(1)).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseToolsEnv } from '../../src/parse-tools-env.js';

test('undefined → undefined (means "all tools, default")', () => {
  assert.equal(parseToolsEnv(undefined), undefined);
});

test('empty string / whitespace → undefined', () => {
  assert.equal(parseToolsEnv(''), undefined);
  assert.equal(parseToolsEnv('   '), undefined);
});

test('single valid name → array', () => {
  assert.deepEqual(parseToolsEnv('hybrid_search'), ['hybrid_search']);
});

test('CSV of valid names → array preserving order', () => {
  assert.deepEqual(parseToolsEnv('rag_ask,hybrid_search'), ['rag_ask', 'hybrid_search']);
});

test('CSV with surrounding whitespace → trimmed', () => {
  assert.deepEqual(parseToolsEnv(' rag_ask , hybrid_search '), [
    'rag_ask',
    'hybrid_search',
  ]);
});

test('CSV with trailing comma + empty segment → ignored', () => {
  assert.deepEqual(parseToolsEnv('hybrid_search,,rag_ask,'), ['hybrid_search', 'rag_ask']);
});

test('unknown name → throws with the invalid name in the message', () => {
  assert.throws(() => parseToolsEnv('hybrid_search,fake_tool'), /fake_tool/);
});

test('multiple unknown names → all reported in one throw', () => {
  assert.throws(() => parseToolsEnv('fake_a,fake_b'), /fake_a.*fake_b/);
});

test('error message lists the valid tool names for partner self-recovery', () => {
  assert.throws(() => parseToolsEnv('nope'), /hybrid_search.*record_query.*rag_ask.*document_ask/);
});
