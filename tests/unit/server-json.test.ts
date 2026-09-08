/**
 * server.json drift guard — the MCP Registry manifest at the repo root.
 *
 * The official MCP Registry (registry.modelcontextprotocol.io) indexes the
 * server from this manifest. Two things make it brittle and are checked here:
 *
 *   1. Three identities MUST agree or the registry's ownership check fails:
 *      server.json `name`  ==  package.json `mcpName`  ==  the GitHub-auth'd
 *      namespace (io.github.vectros-ai/…). The npm-package check additionally
 *      requires `identifier` == package.json `name`.
 *   2. The declared version is published immutably, so server.json's version
 *      (top-level AND packages[].version) must track package.json on every bump
 *      — a stale manifest re-publish is rejected, a mismatched one mis-lists.
 *
 * These are pure structural assertions (no network); full JSON-Schema
 * validation against the official 2025-12-11 schema is run as a release gate,
 * not in unit tests (it requires fetching the schema). The drift this guards is
 * what actually breaks a publish: a forgotten version sync or an identifier typo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TOOL_NAMES } from '../../src/tools/index.js';

const read = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const server = read('../../server.json');
const pkg = read('../../package.json');
const manifest = read('../../mcpb/manifest.json');
const pkgs = (server.packages as Array<Record<string, unknown>>)[0];

// The official registry name pattern (server.schema.json 2025-12-11).
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

test('name is reverse-DNS, GitHub-namespaced, and matches package.json mcpName', () => {
  assert.match(server.name as string, NAME_RE);
  assert.ok(
    (server.name as string).startsWith('io.github.'),
    'GitHub-auth ownership requires an io.github.<owner>/ namespace',
  );
  assert.equal(server.name, pkg.mcpName);
});

test('description is present and within the registry 1–100 char limit', () => {
  const d = server.description as string;
  assert.ok(d.length >= 1 && d.length <= 100, `description length ${d.length} out of [1,100]`);
});

test('versions are aligned across package.json, server.json, and the .mcpb manifest', () => {
  // All release artifacts are hand-synced; a drift here makes the release-CI
  // `paths:` triggers misfire (a stale registry version / wrong .mcpb). Pin them.
  assert.equal(server.version, pkg.version);
  assert.equal(pkgs.version, pkg.version);
  assert.equal(manifest.version, pkg.version);
});

test('npm package coordinates point at the published package', () => {
  assert.equal(pkgs.registryType, 'npm');
  assert.equal(pkgs.identifier, pkg.name);
  assert.equal(pkgs.registryBaseUrl, 'https://registry.npmjs.org');
});

test('transport is stdio (the bare `npx` entry point)', () => {
  assert.equal((pkgs.transport as Record<string, unknown>).type, 'stdio');
});

test('repository points at the public GitHub mirror', () => {
  // The manifest must reference the public mirror, never the internal monorepo.
  // The positive assertion below pins that; the broad "no internal refs" sweep
  // is owned by the mirror scrub gate (and re-asserting it here would require
  // embedding the internal host literal, which the scrub itself rejects).
  const repo = server.repository as Record<string, unknown>;
  assert.equal(repo.source, 'github');
  assert.equal(repo.url, 'https://github.com/vectros-ai/vectros-mcp-server');
});

test('VECTROS_API_KEY env var is declared required + secret', () => {
  const env = pkgs.environmentVariables as Array<Record<string, unknown>>;
  const key = env.find((e) => e.name === 'VECTROS_API_KEY');
  assert.ok(key, 'VECTROS_API_KEY must be declared');
  assert.equal(key!.isRequired, true);
  assert.equal(key!.isSecret, true);
});

test('the .mcpb extension tool list matches the real tool registry exactly', () => {
  // The Claude Desktop extension lists every tool by name, and that list is PUBLISHED
  // surface a user reads before installing — but nothing derives it from the registry,
  // so adding a tool silently leaves it short (a user sees a catalog that under-reports
  // what the extension actually installs). Pin it to TOOL_NAMES, the same invariant the
  // server itself registers from.
  const tools = manifest.tools as Array<Record<string, unknown>>;
  const listed = tools.map((t) => t.name as string).sort();
  assert.deepEqual(
    listed,
    [...TOOL_NAMES].sort(),
    'mcpb/manifest.json `tools` must name exactly the registered tools',
  );
  for (const t of tools) {
    assert.ok(
      typeof t.description === 'string' && (t.description as string).trim().length > 0,
      `${t.name as string}: extension listing needs a description`,
    );
  }
});

test('the extension long_description tool count tracks the real tool registry', () => {
  // Same class of drift as the VECTROS_MCP_TOOLS count below, on a different published
  // copy: the store listing states "N data-plane tools" in prose.
  assert.match(
    manifest.long_description as string,
    new RegExp(`${TOOL_NAMES.length} data-plane tools`),
    `expected long_description to say "${TOOL_NAMES.length} data-plane tools"`,
  );
});

test('the documented tool count tracks the real tool registry', () => {
  // The VECTROS_MCP_TOOLS env description states "all N tools" — keep N honest
  // so a tool added/removed in the registry forces a manifest copy update.
  const env = pkgs.environmentVariables as Array<Record<string, unknown>>;
  const toolsVar = env.find((e) => e.name === 'VECTROS_MCP_TOOLS');
  assert.ok(toolsVar, 'VECTROS_MCP_TOOLS must be declared');
  assert.match(
    toolsVar!.description as string,
    new RegExp(`all ${TOOL_NAMES.length} tools`),
    `expected the env description to say "all ${TOOL_NAMES.length} tools"`,
  );
});
