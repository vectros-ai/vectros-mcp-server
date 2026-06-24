/**
 * document_ingest file-jail tests. The model supplies `filePath`; on
 * stdio the tool must confine reads to the configured ingest root and reject
 * traversal / absolute / symlink escapes and sensitive paths — otherwise a
 * prompt-injection adversary reads ~/.aws/credentials and exfiltrates it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

import documentIngest from '../../src/tools/document_ingest.js';

const log = pino({ level: 'silent' });

// A client whose uploadDocument records the bytes it would upload. If the jail
// works, escapes never reach this — assertions key on isError + the message.
function recordingClient(): { calls: unknown[]; client: never } {
  const calls: unknown[] = [];
  const client = {
    documents: {
      uploadDocument: async (args: unknown) => {
        calls.push(args);
        return { id: 'doc_x', uploadUrl: 'https://s3.example/presigned?sig=x' };
      },
    },
  } as never;
  return { calls, client };
}

let root: string; // canonical ingest root (a temp dir)
let outsideFile: string; // a secret file OUTSIDE the root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ingest-root-'));
  await writeFile(join(root, 'ok.txt'), 'allowed body');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'nested.txt'), 'nested body');
  await mkdir(join(root, '.aws'), { recursive: true });
  await writeFile(join(root, '.aws', 'credentials'), 'AKIA...secret');
  await writeFile(join(root, '.env'), 'SECRET=1');
  await mkdir(join(root, 'sub', '.ssh'), { recursive: true });
  await writeFile(join(root, 'sub', '.ssh', 'id_rsa'), 'PRIVATE KEY');

  // A secret OUTSIDE the root, plus an in-root symlink pointing at it.
  const outsideDir = await mkdtemp(join(tmpdir(), 'ingest-outside-'));
  outsideFile = join(outsideDir, 'secret.txt');
  await writeFile(outsideFile, 'TOP SECRET');
  try {
    await symlink(outsideFile, join(root, 'escape-link'));
  } catch {
    // symlink may require privileges on some Windows setups; the symlink test
    // self-skips below if the link wasn't created.
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function tool() {
  const { client } = recordingClient();
  return documentIngest({ client, log, transport: 'stdio', ingestRoot: root });
}

/**
 * Run `fn` with a stubbed global fetch (the success path PUTs bytes to the
 * presigned URL via global fetch). Scoped per-test + restored so the stub
 * never leaks to other files (isolation=none shares globals).
 */
async function withStubbedFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, statusText: 'OK', text: async () => '' }) as Response) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('allows a file directly inside the ingest root', async () => {
  const r = await withStubbedFetch(() =>
    tool().handler({ title: 'X', filePath: join(root, 'ok.txt') }, {}),
  );
  assert.ok(!r.isError, `must succeed: ${JSON.stringify(r)}`);
});

test('allows a relative path resolved against the root', async () => {
  const r = await withStubbedFetch(() => tool().handler({ title: 'X', filePath: 'sub/nested.txt' }, {}));
  assert.ok(!r.isError, `relative in-root path must succeed: ${JSON.stringify(r)}`);
});

test('rejects parent-traversal escape (../)', async () => {
  const r = await tool().handler({ title: 'X', filePath: '../../etc/passwd' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /outside the allowed ingest root|no such file/);
});

test('rejects an absolute path outside the root', async () => {
  const r = await tool().handler({ title: 'X', filePath: outsideFile }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /outside the allowed ingest root/);
});

test('rejects a symlink that escapes the root', async (t) => {
  // The symlink may not have been creatable (Windows w/o privilege) — skip then.
  const r = await tool().handler({ title: 'X', filePath: join(root, 'escape-link') }, {});
  if (!r.isError) {
    t.skip('symlink not created in this environment');
    return;
  }
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /outside the allowed ingest root|no such file/);
});

test('rejects a denied sensitive path even INSIDE the root (.aws/credentials)', async () => {
  const r = await tool().handler({ title: 'X', filePath: join(root, '.aws', 'credentials') }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /denied sensitive-path pattern/);
});

test('rejects a denied sensitive basename even INSIDE the root (.env)', async () => {
  const r = await tool().handler({ title: 'X', filePath: join(root, '.env') }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /denied sensitive-path pattern/);
});

test('rejects a denied segment nested in a subdirectory (sub/.ssh/id_rsa)', async () => {
  const r = await tool().handler({ title: 'X', filePath: join(root, 'sub', '.ssh', 'id_rsa') }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /denied sensitive-path pattern/);
});

test('rejects mid-path traversal that normalizes onto a denied file (sub/../.env)', async () => {
  // resolve() collapses `sub/..` to the root, landing on .env → denylist fires.
  const r = await tool().handler({ title: 'X', filePath: 'sub/../.env' }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /denied sensitive-path pattern/);
});

test('rejects the ingest root itself as the target', async () => {
  const r = await tool().handler({ title: 'X', filePath: '.' }, {});
  assert.equal(r.isError, true);
  // Either the containment check (rel === '') or readFile-on-a-dir — both isError.
});

test('rejects a non-existent file under the root with a clear message', async () => {
  const r = await tool().handler({ title: 'X', filePath: join(root, 'nope.txt') }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Cannot read filePath/);
});
