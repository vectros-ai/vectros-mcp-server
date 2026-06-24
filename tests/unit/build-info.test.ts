import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_INFO, formatBuildInfo } from '../../src/build-info.js';

// Under tsx (this runner) tsup's `define` is NOT applied, so BUILD_INFO falls
// back to 'dev'. The real build-stamped values are exercised by the built
// binary's `--version`; here we pin the fallback + format so neither regresses.

test('BUILD_INFO falls back to "dev" under tsx (no tsup define)', () => {
  assert.equal(BUILD_INFO.mcpServer, 'dev');
  assert.equal(BUILD_INFO.sdk, 'dev');
});

test('formatBuildInfo() renders mcp-server + bundled sdk provenance', () => {
  const s = formatBuildInfo();
  assert.match(s, /^vectros-mcp-server .+ \(sdk .+\)$/);
  assert.ok(s.includes('sdk '));
});
