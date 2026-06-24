import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { parseApiKey, warnOnSuboptimalKey, InvalidApiKeyError } from '../../src/auth.js';

// Silent logger — capture into an array to assert on warn output.
function captureLogger() {
  const warnings: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
  const log = pino(
    { level: 'warn' },
    {
      write: (chunk: string) => {
        const parsed = JSON.parse(chunk);
        if (parsed.level >= 40) {
          warnings.push({ msg: parsed.msg, ctx: { ...parsed } });
        }
      },
    },
  );
  return { log, warnings };
}

test('parseApiKey accepts ssk_live_ keys', () => {
  const info = parseApiKey('ssk_live_abc123_xyz');
  assert.equal(info.prefix, 'ssk');
  assert.equal(info.env, 'live');
  assert.equal(info.raw, 'ssk_live_abc123_xyz');
});

test('parseApiKey accepts ssk_test_, sk_live_, sk_test_, st_live_, st_test_', () => {
  for (const key of ['ssk_test_abc', 'sk_live_abc', 'sk_test_abc', 'st_live_abc', 'st_test_abc']) {
    const info = parseApiKey(key);
    assert.ok(info.prefix);
    assert.ok(info.env);
  }
});

test('parseApiKey throws InvalidApiKeyError on undefined/empty', () => {
  assert.throws(() => parseApiKey(undefined), InvalidApiKeyError);
  assert.throws(() => parseApiKey(''), InvalidApiKeyError);
  assert.throws(() => parseApiKey('   '), InvalidApiKeyError);
});

test('parseApiKey throws on malformed prefix', () => {
  assert.throws(() => parseApiKey('xx_live_abc'), InvalidApiKeyError);
  assert.throws(() => parseApiKey('ssk_prod_abc'), InvalidApiKeyError);
  assert.throws(() => parseApiKey('not-a-key'), InvalidApiKeyError);
});

test('warnOnSuboptimalKey warns on sk_*', () => {
  const { log, warnings } = captureLogger();
  warnOnSuboptimalKey(parseApiKey('sk_live_abc'), log);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /wildcard-scope/);
});

test('warnOnSuboptimalKey warns on st_*', () => {
  const { log, warnings } = captureLogger();
  warnOnSuboptimalKey(parseApiKey('st_test_abc'), log);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /short-lived/);
});

test('warnOnSuboptimalKey silent on ssk_*', () => {
  const { log, warnings } = captureLogger();
  warnOnSuboptimalKey(parseApiKey('ssk_live_abc'), log);
  assert.equal(warnings.length, 0);
});
