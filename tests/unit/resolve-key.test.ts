/**
 * Key-resolution tests.
 *
 * Three layers, because the risk is not evenly spread:
 *   - resolveApiKey's precedence (env wins / keyring fallback / actionable none),
 *     with the subprocess stubbed via the `runHelper` seam;
 *   - mapExecResult, which owns the whole exit-code contract — the part most
 *     likely to be wrong, extracted pure so it can be table-tested with no spawn;
 *   - resolveCommandPath, the PATH/PATHEXT lookup that decides WHICH binary runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveApiKey,
  noKeyMessage,
  keyringNotice,
  mapExecResult,
  redactDetail,
  resolveCommandPath,
  defaultRunHelper,
  type ExecFileLike,
  type HelperArgs,
  type HelperOutcome,
} from '../../src/resolve-key.js';

/** A runHelper stub that records how it was called and returns a fixed outcome. */
function stubHelper(outcome: HelperOutcome): {
  run: (args: HelperArgs) => Promise<HelperOutcome>;
  calls: HelperArgs[];
} {
  const calls: HelperArgs[] = [];
  return {
    calls,
    run: (args: HelperArgs) => {
      calls.push(args);
      return Promise.resolve(outcome);
    },
  };
}

// ── resolveApiKey: precedence ─────────────────────────────────────────────

test('env VECTROS_API_KEY wins and the helper is never consulted', async () => {
  const helper = stubHelper({ status: 'ok', secret: 'ssk_live_fromkeyring' });
  const r = await resolveApiKey({
    env: { VECTROS_API_KEY: 'ssk_live_fromenv' },
    runHelper: helper.run,
  });
  assert.equal(r.source, 'env');
  assert.equal(r.key, 'ssk_live_fromenv');
  assert.equal(helper.calls.length, 0);
});

test('env key is trimmed (a $(...) capture keeps a trailing newline)', async () => {
  const r = await resolveApiKey({ env: { VECTROS_API_KEY: 'ssk_live_x\n' } });
  assert.equal(r.key, 'ssk_live_x');
});

test('blank/whitespace env is treated as unset → falls through to the helper', async () => {
  const helper = stubHelper({ status: 'ok', secret: 'ssk_live_kr' });
  const r = await resolveApiKey({ env: { VECTROS_API_KEY: '   ' }, runHelper: helper.run });
  assert.equal(r.source, 'keyring');
  assert.equal(r.key, 'ssk_live_kr');
  assert.equal(helper.calls.length, 1);
});

test('no env → helper secret is used, source keyring', async () => {
  const helper = stubHelper({ status: 'ok', secret: 'ssk_live_kr' });
  const r = await resolveApiKey({ env: {}, runHelper: helper.run });
  assert.equal(r.source, 'keyring');
  assert.equal(r.key, 'ssk_live_kr');
});

test('VECTROS_KEYRING_ALIAS is forwarded to the helper and echoed back for logging', async () => {
  const helper = stubHelper({ status: 'ok', secret: 'ssk_live_kr' });
  const r = await resolveApiKey({ env: { VECTROS_KEYRING_ALIAS: 'prod-key' }, runHelper: helper.run });
  assert.equal(helper.calls[0].alias, 'prod-key');
  assert.equal(r.alias, 'prod-key', 'the alias must be surfaced so startup can log which identity');
});

test('helper cli-absent → source none, reason cli-absent', async () => {
  const r = await resolveApiKey({ env: {}, runHelper: stubHelper({ status: 'cli-absent' }).run });
  assert.equal(r.source, 'none');
  assert.equal(r.reason, 'cli-absent');
  assert.equal(r.key, undefined);
});

test('helper no-usable-key → source none, reason no-usable-key', async () => {
  const r = await resolveApiKey({ env: {}, runHelper: stubHelper({ status: 'no-usable-key' }).run });
  assert.equal(r.source, 'none');
  assert.equal(r.reason, 'no-usable-key');
});

test('helper error → source none, reason helper-failed, detail surfaced', async () => {
  const r = await resolveApiKey({
    env: {},
    runHelper: stubHelper({ status: 'error', detail: 'boom' }).run,
  });
  assert.equal(r.source, 'none');
  assert.equal(r.reason, 'helper-failed');
  assert.equal(r.detail, 'boom');
});

test('a bad alias is rejected BEFORE the helper runs (injection guard)', async () => {
  const helper = stubHelper({ status: 'ok', secret: 'x' });
  const r = await resolveApiKey({
    env: { VECTROS_KEYRING_ALIAS: 'evil; rm -rf /' },
    runHelper: helper.run,
  });
  assert.equal(r.source, 'none');
  assert.equal(r.reason, 'bad-alias');
  assert.equal(helper.calls.length, 0, 'helper must not be invoked with an unsafe alias');
});

test('every shell metacharacter class is rejected as an alias', async () => {
  for (const bad of ['a b', 'a&b', 'a|b', 'a;b', 'a`b`', 'a$(b)', 'a>b', 'a"b', "a'b", 'a\\b', 'a/b']) {
    const helper = stubHelper({ status: 'ok', secret: 'x' });
    const r = await resolveApiKey({ env: { VECTROS_KEYRING_ALIAS: bad }, runHelper: helper.run });
    assert.equal(r.reason, 'bad-alias', `alias ${JSON.stringify(bad)} must be rejected`);
    assert.equal(helper.calls.length, 0);
  }
});

test('valid alias charset (dot/dash/underscore) is accepted', async () => {
  const helper = stubHelper({ status: 'ok', secret: 'x' });
  const r = await resolveApiKey({
    env: { VECTROS_KEYRING_ALIAS: 'agentic-sdlc.prod_1' },
    runHelper: helper.run,
  });
  assert.equal(r.source, 'keyring');
  assert.equal(helper.calls.length, 1);
});

// ── mapExecResult: the exit-code contract ─────────────────────────────────

const execErr = (code: string | number, message = 'failed'): Error & { code?: string | number } =>
  Object.assign(new Error(message), { code });

test('mapExecResult: success with a secret → ok (trimmed)', () => {
  assert.deepEqual(mapExecResult(null, '  ssk_live_x \n'), { status: 'ok', secret: 'ssk_live_x' });
});

test('mapExecResult: success with empty stdout → no-usable-key', () => {
  assert.deepEqual(mapExecResult(null, '   \n'), { status: 'no-usable-key' });
});

test('mapExecResult: ENOENT → cli-absent', () => {
  assert.deepEqual(mapExecResult(execErr('ENOENT'), ''), { status: 'cli-absent' });
});

test('mapExecResult: exit 2 (no such entry / no active) → no-usable-key', () => {
  assert.equal(mapExecResult(execErr(2), '', '').status, 'no-usable-key');
});

test('mapExecResult: exit 1 (entry found, secret unreadable) → no-usable-key, NOT a generic error', () => {
  // The CLI returns 1 when the entry resolves but its secret will not decrypt —
  // a machine-key change. Reporting that as a generic helper failure would send
  // the user chasing an exec problem instead of the keyring.
  assert.equal(mapExecResult(execErr(1), '', '').status, 'no-usable-key');
});

test('mapExecResult: other exit codes → error carrying the redacted detail', () => {
  // Assert the DETAIL, not just the status — the previous version of this test
  // checked only `status === 'error'` while claiming to check the detail.
  const outcome = mapExecResult(execErr(127, 'boom ssk_live_LEAK99'), '', '');
  assert.equal(outcome.status, 'error');
  const detail = (outcome as { detail: string }).detail;
  assert.match(detail, /boom/, 'the failure text must survive');
  assert.doesNotMatch(detail, /LEAK99/, 'a key in it must not');
});

test('mapExecResult prefers the child stderr over execFile’s command-line message', () => {
  const outcome = mapExecResult(execErr(2, 'Command failed: "C:\\x\\vectros.cmd" keyring show'), '', '✖ No active identity.');
  assert.equal(outcome.status, 'no-usable-key');
  const detail = (outcome as { detail?: string }).detail ?? '';
  assert.match(detail, /No active identity/);
  assert.doesNotMatch(detail, /Command failed/, 'the raw command line is noise, not diagnosis');
});

test('mapExecResult: a killed/timed-out child → error', () => {
  const err = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
  assert.equal(mapExecResult(err, '').status, 'error');
});

// ── redactDetail: nothing key-shaped reaches a fatal log ──────────────────

test('redactDetail strips key-shaped tokens from helper failure text', () => {
  // The helper is a separately-versioned binary; if a future build ever echoes a
  // key to stderr, that text must not land in the fatal log verbatim.
  const detail = redactDetail('Command failed: vectros\nssk_live_abc123DEF leaked\nst_test_zzz too');
  assert.doesNotMatch(detail, /ssk_live_abc123DEF/);
  assert.doesNotMatch(detail, /st_test_zzz/);
  assert.match(detail, /\[redacted\]/);
});

test('redactDetail catches keys a word-boundary anchor would have missed', () => {
  // `_` is a word character, so /\b(ssk|sk|st)_/ does NOT match after one — the
  // anchor excused exactly the embedded case worth catching.
  assert.doesNotMatch(redactDetail('MY_KEY_ssk_live_SECRET99'), /SECRET99/);
  assert.doesNotMatch(redactDetail('key=ssk_live_SECRET99;'), /SECRET99/);
  assert.doesNotMatch(redactDetail('SSK_LIVE_SECRET99'), /SECRET99/, 'case must not matter');
});

test('redactDetail redacts BEFORE truncating, so a cut cannot expose a key prefix', () => {
  const detail = redactDetail(`${'x'.repeat(190)} ssk_live_SECRET99`);
  assert.doesNotMatch(detail, /ssk_live/, 'the key must be gone before the 200-char cut');
  assert.ok(detail.length <= 201);
});

test('redactDetail caps a pathological multi-KB stderr', () => {
  const detail = redactDetail('x'.repeat(5000));
  assert.ok(detail.length <= 201, `expected a capped detail, got ${detail.length} chars`);
});

test('a helper-failed message survives redaction end-to-end (no key in the fatal text)', async () => {
  const r = await resolveApiKey({
    env: {},
    runHelper: () =>
      Promise.resolve(mapExecResult(execErr(127, 'boom ssk_live_SECRET99 boom'), '')),
  });
  assert.equal(r.reason, 'helper-failed');
  assert.doesNotMatch(noKeyMessage(r), /ssk_live_SECRET99/);
});

// ── resolveCommandPath: which binary actually runs ────────────────────────

test('resolveCommandPath finds a command on PATH and returns an ABSOLUTE path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    const isWin = process.platform === 'win32';
    const file = path.join(dir, isWin ? 'faketool.CMD' : 'faketool');
    await fs.writeFile(file, '', { mode: 0o755 });
    const found = resolveCommandPath('faketool', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    assert.ok(found, 'expected the command to be found');
    // Assert absoluteness DIRECTLY. Comparing path.resolve(found) to
    // path.resolve(file) would normalise a relative return before comparing, and
    // so could never fail on the very defect this test is named for.
    assert.ok(path.isAbsolute(found), `expected an absolute path, got ${found}`);
    assert.equal(found, file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveCommandPath IGNORES a relative PATH entry (the cwd-hijack vector)', async () => {
  // `.` on PATH would resolve against the process cwd — so a hostile `vectros`
  // dropped in a cloned repo the server was started in would be found, and a bare
  // relative name handed to the shell lets cmd.exe re-resolve it from cwd anyway.
  // Absolute-or-nothing is the precondition the whole spawn argument rests on.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const isWin = process.platform === 'win32';
    await fs.writeFile(path.join(dir, isWin ? 'faketool.CMD' : 'faketool'), '', { mode: 0o755 });
    for (const relative of ['.', './', 'subdir']) {
      assert.equal(
        resolveCommandPath('faketool', { PATH: relative, PATHEXT: '.CMD' }),
        undefined,
        `relative PATH entry ${JSON.stringify(relative)} must never resolve`,
      );
    }
  } finally {
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveCommandPath: PATHEXT="" falls back to defaults rather than finding nothing', async () => {
  // `??` would accept the empty string, yielding an empty extension list, an
  // inner loop that never runs, and a false "the CLI is not installed".
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    await fs.writeFile(path.join(dir, 'faketool.CMD'), '', { mode: 0o755 });
    const found = resolveCommandPath('faketool', { PATH: dir, PATHEXT: '' }, 'win32');
    assert.ok(found, 'an empty PATHEXT must not mean "no extensions"');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveCommandPath: absent command / unset PATH / empty PATH → undefined', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    assert.equal(resolveCommandPath('faketool', { PATH: dir }), undefined);
    assert.equal(resolveCommandPath('faketool', {}), undefined);
    assert.equal(resolveCommandPath('faketool', { PATH: '' }), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveCommandPath ignores a DIRECTORY that shares the command name', async () => {
  // A bare existence check would accept this and then fail the spawn with a
  // confusing EACCES instead of a clean "CLI not installed".
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    await fs.mkdir(path.join(dir, 'faketool'));
    assert.equal(resolveCommandPath('faketool', { PATH: dir }), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveCommandPath tolerates quoted and blank PATH entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    const isWin = process.platform === 'win32';
    const file = path.join(dir, isWin ? 'faketool.CMD' : 'faketool');
    await fs.writeFile(file, '', { mode: 0o755 });
    const messyPath = ['', `"${dir}"`, ''].join(path.delimiter);
    const found = resolveCommandPath('faketool', { PATH: messyPath, PATHEXT: '.CMD' });
    assert.ok(found, 'a quoted PATH entry must still resolve');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── keyringNotice: what startup discloses about the identity ──────────────

test('keyringNotice: an env-sourced key discloses nothing (it was explicit)', () => {
  assert.equal(keyringNotice({ source: 'env', key: 'ssk_live_x' }), undefined);
  assert.equal(keyringNotice({ source: 'none', reason: 'cli-absent' }), undefined);
});

test('keyringNotice WARNS when the key came from the active entry with no alias named', () => {
  // The surprise case: a blank VECTROS_API_KEY placeholder resolves like an unset
  // one, so an agent the user thinks is unconfigured runs as the active identity.
  const notice = keyringNotice({ source: 'keyring', key: 'ssk_live_x' });
  assert.equal(notice?.level, 'warn');
  assert.equal(notice?.alias, '(active)');
  assert.match(notice?.message ?? '', /no entry was named/);
  assert.match(notice?.message ?? '', /VECTROS_KEYRING_ALIAS/, 'must name the way to be explicit');
  assert.match(notice?.message ?? '', /keyring doctor/, 'must name the way to see which entry is active');
});

test('keyringNotice warns for ANY credential picked implicitly — test keys included', () => {
  // A regression guard, not a proof: keyringNotice deliberately does not inspect
  // the key at all, so this pins the DESIGN (both directions are unwelcome —
  // silently touching real data, and silently not touching it when you believed
  // you were) against anyone reintroducing tenant-gating here. Two cases suffice
  // to express that; more would just repeat one assertion.
  assert.equal(keyringNotice({ source: 'keyring', key: 'ssk_live_x' })?.level, 'warn');
  assert.equal(keyringNotice({ source: 'keyring', key: 'ssk_test_x' })?.level, 'warn');
});

test('keyringNotice does NOT warn when an entry was named explicitly', () => {
  // Choosing an identity on purpose is not a surprise — warning would cry wolf.
  for (const key of ['ssk_live_x', 'ssk_test_x']) {
    const notice = keyringNotice({ source: 'keyring', key, alias: 'chosen' });
    assert.equal(notice?.level, 'info', `${key} named explicitly should stay info`);
    assert.equal(notice?.alias, 'chosen');
  }
});

test('keyringNotice never mentions deployments — customers only ever have one', () => {
  // staging/production is an internal axis a customer never sees; the only thing
  // that varies for them is the key's tenant (live vs test).
  const msg = keyringNotice({ source: 'keyring', key: 'ssk_live_x' })?.message ?? '';
  assert.doesNotMatch(msg, /production|staging/i);
});

test('keyringNotice never puts the secret in its message', () => {
  const notice = keyringNotice({ source: 'keyring', key: 'ssk_live_SECRET99' });
  assert.doesNotMatch(notice?.message ?? '', /SECRET99/);
});

// ── defaultRunHelper: the composed spawn (where the hijack fix is APPLIED) ──

/** Capture what defaultRunHelper would spawn, without spawning it. */
function captureSpawn(): { calls: Array<{ file: string; args: string[]; shell: boolean }>; exec: ExecFileLike } {
  const calls: Array<{ file: string; args: string[]; shell: boolean }> = [];
  const exec: ExecFileLike = (file, args, options, cb) => {
    calls.push({ file, args, shell: options.shell });
    cb(null, 'ssk_live_x\n', '');
  };
  return { calls, exec };
}

test('defaultRunHelper spawns the ABSOLUTE resolved path, quoted, on Windows', async () => {
  // The hijack fix is only real if the absolute path actually reaches the shell:
  // a bare `vectros` would let cmd.exe search the current directory first.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    const file = path.join(dir, 'vectros.CMD');
    await fs.writeFile(file, '', { mode: 0o755 });
    const { calls, exec } = captureSpawn();
    const outcome = await defaultRunHelper(
      { alias: undefined, env: { PATH: dir, PATHEXT: '.CMD' } },
      { platform: 'win32', execFileImpl: exec },
    );
    assert.deepEqual(outcome, { status: 'ok', secret: 'ssk_live_x' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, `"${file}"`, 'the absolute path must be passed, quoted');
    assert.ok(path.isAbsolute(calls[0].file.replace(/"/g, '')), 'never a bare/relative command name');
    assert.equal(calls[0].shell, true, 'Windows needs a shell for the .cmd shim');
    assert.deepEqual(calls[0].args, ['keyring', 'show', '--format', 'raw']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('defaultRunHelper spawns unquoted with NO shell on posix, and forwards --alias', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    const file = path.join(dir, 'vectros');
    await fs.writeFile(file, '', { mode: 0o755 });
    const { calls, exec } = captureSpawn();
    await defaultRunHelper(
      { alias: 'my-entry', env: { PATH: dir } },
      { platform: 'linux', execFileImpl: exec },
    );
    assert.equal(calls[0].file, file, 'no shell → no quoting');
    assert.equal(calls[0].shell, false);
    assert.deepEqual(calls[0].args, ['keyring', 'show', '--format', 'raw', '--alias', 'my-entry']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('defaultRunHelper reports cli-absent WITHOUT spawning when the command is not on PATH', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    const { calls, exec } = captureSpawn();
    const outcome = await defaultRunHelper(
      { alias: undefined, env: { PATH: dir } },
      { platform: 'linux', execFileImpl: exec },
    );
    assert.deepEqual(outcome, { status: 'cli-absent' });
    assert.equal(calls.length, 0, 'absence is decided by the lookup, never by spawning');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('defaultRunHelper surfaces the child stderr as a redacted detail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectros-path-'));
  try {
    await fs.writeFile(path.join(dir, 'vectros'), '', { mode: 0o755 });
    const exec: ExecFileLike = (_file, _args, _options, cb) =>
      cb(Object.assign(new Error('Command failed'), { code: 1 }), '', '  ✖ Keyring index is corrupt.\n');
    const outcome = await defaultRunHelper(
      { alias: undefined, env: { PATH: dir } },
      { platform: 'linux', execFileImpl: exec },
    );
    assert.equal(outcome.status, 'no-usable-key');
    assert.match(
      (outcome as { detail?: string }).detail ?? '',
      /Keyring index is corrupt/,
      "the CLI's own diagnosis must survive, not be replaced by a guess",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── noKeyMessage ──────────────────────────────────────────────────────────

test('noKeyMessage names both escape hatches for EVERY reason, bad-alias included', () => {
  // bad-alias used to be excluded from this loop and given a weaker assertion —
  // encoding the exception in the test instead of fixing the message, which left
  // the one branch the docblock's "every branch" claim was false for.
  for (const reason of ['cli-absent', 'no-usable-key', 'helper-failed', 'bad-alias'] as const) {
    const msg = noKeyMessage({ source: 'none', reason, detail: 'x' });
    assert.match(msg, /VECTROS_API_KEY/, `${reason} message should mention the env var`);
    assert.match(msg, /vectros/, `${reason} message should mention the CLI`);
  }
  assert.match(noKeyMessage({ source: 'none', reason: 'bad-alias', detail: 'x' }), /VECTROS_KEYRING_ALIAS/);
});

test('noKeyMessage carries the CLI’s own diagnosis instead of asserting a cause', () => {
  // Exit 1 is the CLI's catch-all (a corrupt index throws there), so claiming
  // "no active identity" would be a false statement of fact. Pass its text through.
  const msg = noKeyMessage({ source: 'none', reason: 'no-usable-key', detail: 'Keyring index is corrupt.' });
  assert.match(msg, /Keyring index is corrupt/);
});

test('noKeyMessage does not send an old CLI to commands it lacks without saying so', () => {
  // `keyring doctor` ships in CLI 0.10.0 — for the older-CLI users a resolution
  // failure actually reaches, an unqualified suggestion is another dead end.
  const msg = noKeyMessage({ source: 'none', reason: 'no-usable-key' });
  assert.match(msg, /0\.10\.0\+/, 'keyring doctor must carry its version floor');
  assert.match(msg, /upgrade @vectros-ai\/cli/, 'and upgrading must be offered as a remedy');
});

test('the no-usable-key message routes to keyring doctor (covers unreadable + no-active alike)', () => {
  assert.match(noKeyMessage({ source: 'none', reason: 'no-usable-key' }), /keyring doctor/);
});
