/**
 * Unit tests for the paged-envelope helpers (src/paging.ts).
 *
 * These are the pure-helper tests for the SDK 0.23 envelope absorption —
 * the tool handlers' SDK plumbing is exercised in tools-handlers.test.ts;
 * here we pin the drain/unwrap semantics directly, including the
 * null-cursor termination that prevents the infinite-loop regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drainPages, pageItems, type Page } from '../../src/paging.js';

test('pageItems unwraps data, defaulting absent/empty to []', () => {
  assert.deepEqual(pageItems({ data: [1, 2, 3] }), [1, 2, 3]);
  assert.deepEqual(pageItems({ data: [] }), []);
  assert.deepEqual(pageItems({}), [], 'absent data → empty array');
  assert.deepEqual(pageItems({ data: undefined, nextCursor: null }), []);
});

test('drainPages returns a single page when nextCursor is null', async () => {
  const calls: Array<string | undefined> = [];
  const out = await drainPages<number>(async (startFrom) => {
    calls.push(startFrom);
    return { data: [1, 2], nextCursor: null };
  });
  assert.deepEqual(out, [1, 2]);
  assert.deepEqual(calls, [undefined], 'one call; first startFrom is undefined');
});

test('drainPages follows nextCursor across pages and flattens', async () => {
  const pages: Record<string, Page<number>> = {
    FIRST: { data: [1, 2], nextCursor: 'a' },
    a: { data: [3, 4], nextCursor: 'b' },
    b: { data: [5], nextCursor: null },
  };
  const calls: Array<string | undefined> = [];
  const out = await drainPages<number>(async (startFrom) => {
    calls.push(startFrom);
    return pages[startFrom ?? 'FIRST'];
  });
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
  assert.deepEqual(calls, [undefined, 'a', 'b'], 'each nextCursor fed back as startFrom');
});

test('drainPages terminates on a NON-full final page carrying a null cursor (no infinite loop)', async () => {
  // The exact regression class: a partial last page (data shorter than the
  // page size) with nextCursor=null must end the loop. Terminating on page
  // fullness instead of cursor nullity would spin forever here.
  const pages: Record<string, Page<number>> = {
    FIRST: { data: [1, 2, 3], nextCursor: 'next' }, // full page
    next: { data: [4], nextCursor: null }, // partial final page
  };
  let guard = 0;
  const out = await drainPages<number>(async (startFrom) => {
    if (++guard > 10) throw new Error('drainPages did not terminate');
    return pages[startFrom ?? 'FIRST'];
  });
  assert.deepEqual(out, [1, 2, 3, 4]);
  assert.equal(guard, 2, 'exactly two fetches');
});

test('drainPages treats an empty data page with a null cursor as the end', async () => {
  const out = await drainPages<number>(async () => ({ data: [], nextCursor: null }));
  assert.deepEqual(out, []);
});

test('drainPages skips empty interior pages but keeps following the cursor', async () => {
  const pages: Record<string, Page<number>> = {
    FIRST: { data: [], nextCursor: 'a' },
    a: { data: [7], nextCursor: null },
  };
  const out = await drainPages<number>(async (startFrom) => pages[startFrom ?? 'FIRST']);
  assert.deepEqual(out, [7]);
});

test('drainPages keeps paging when an interior page omits data entirely (data: undefined + live cursor)', async () => {
  // Distinct from the empty-array case: `data` absent (undefined) with a
  // non-null cursor must NOT terminate — only a falsy nextCursor does.
  const pages: Record<string, Page<number>> = {
    FIRST: { nextCursor: 'a' }, // no `data` key at all
    a: { data: [9], nextCursor: null },
  };
  const out = await drainPages<number>(async (startFrom) => pages[startFrom ?? 'FIRST']);
  assert.deepEqual(out, [9]);
});
