/**
 * Base-URL validator tests (R1 F-06a) — mirrors the CLI guard. The MCP server
 * sends `Authorization: Bearer ${VECTROS_API_KEY}` to `${baseUrl}/v1/ping`, so
 * an attacker-supplied VECTROS_API_BASE_URL must not be honored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateBaseUrl, InvalidBaseUrlError, INSECURE_BASE_URL_ENV } from '../../src/base-url.js';

test('accepts official + *.vectros.ai hosts', () => {
  assert.equal(validateBaseUrl('https://api.vectros.ai'), 'https://api.vectros.ai');
  assert.equal(validateBaseUrl('https://api.staging.vectros.ai'), 'https://api.staging.vectros.ai');
  assert.equal(validateBaseUrl('https://vectros.ai'), 'https://vectros.ai');
});

test('accepts http only for loopback', () => {
  assert.equal(validateBaseUrl('http://127.0.0.1:1'), 'http://127.0.0.1:1');
  assert.equal(validateBaseUrl('http://localhost:8765'), 'http://localhost:8765');
});

test('rejects look-alike / impostor hosts', () => {
  assert.throws(() => validateBaseUrl('https://api.vectros.ai.evil.com'), InvalidBaseUrlError);
  assert.throws(() => validateBaseUrl('https://evilvectros.ai'), InvalidBaseUrlError);
  assert.throws(() => validateBaseUrl('https://api.vectros.ai@evil.com'), InvalidBaseUrlError);
});

test('rejects an unrelated host', () => {
  assert.throws(() => validateBaseUrl('https://evil.example.com'), /not an official Vectros host/);
});

test('accepts the FQDN trailing-dot form + explicit port', () => {
  assert.equal(validateBaseUrl('https://api.vectros.ai.'), 'https://api.vectros.ai.');
  assert.equal(validateBaseUrl('https://api.vectros.ai:443'), 'https://api.vectros.ai:443');
});

test('rejects http:// for a non-loopback host + non-http(s) schemes', () => {
  assert.throws(() => validateBaseUrl('http://api.vectros.ai'), /insecure http/);
  assert.throws(() => validateBaseUrl('file:///etc/passwd'), InvalidBaseUrlError);
});

test('rejects an unparseable URL', () => {
  assert.throws(() => validateBaseUrl('not a url'), /not a parseable absolute URL/);
});

test('opt-out permits an arbitrary host and warns (no stdout)', () => {
  const warnings: string[] = [];
  const out = validateBaseUrl('https://local-proxy.test', { allowInsecure: true, warn: (m) => warnings.push(m) });
  assert.equal(out, 'https://local-proxy.test');
  assert.match(warnings[0], /UNVALIDATED host/);
});

test('opt-out reads the environment', () => {
  const prev = process.env[INSECURE_BASE_URL_ENV];
  try {
    process.env[INSECURE_BASE_URL_ENV] = 'true';
    assert.equal(validateBaseUrl('https://evil.example.com', { warn: () => {} }), 'https://evil.example.com');
  } finally {
    if (prev === undefined) delete process.env[INSECURE_BASE_URL_ENV];
    else process.env[INSECURE_BASE_URL_ENV] = prev;
  }
});
