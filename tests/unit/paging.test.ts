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

test('drainPages fails closed on an EMPTY page with a LIVE cursor forever (the row-count guard blind spot)', { timeout: 5_000 }, async () => {
  // The exact pathology a row-only guard cannot see: every page comes back
  // empty (a per-page post-filter dropping every row, or an empty-partition
  // scan) while nextCursor never goes null. `all.length` never grows, so a
  // guard of the form `if (all.length > MAX) throw` is unreachable here — the
  // loop must be bounded on PAGES, the thing it actually advances on.
  //
  // Explicit `timeout` is load-bearing, not decoration: this test's whole
  // point is proving the loop is BOUNDED, so if the guard this asserts on is
  // ever deleted/broken, `drainPages` would spin forever and — without this
  // — `node:test`'s default (Infinity) means the test hangs the run instead
  // of failing it.
  let fetches = 0;
  await assert.rejects(
    () =>
      drainPages<number>(async () => {
        fetches++;
        return { data: [], nextCursor: 'still-going' }; // never null, never any rows
      }),
    (err: Error) => {
      assert.match(err.message, /0 rows over \d+ pages/, 'names both counts so the two failure modes are distinguishable');
      assert.match(err.message, /drainPages/);
      return true;
    },
  );
  assert.ok(fetches > 1, 'the guard must actually be reached, not trip on the first call');
});

test('drainPages fails closed when the ROW bound trips well before the page bound (belt-and-suspenders)', async () => {
  // Companion case: a single oversized page pushes accumulated rows past
  // MAX_ROWS on the second fetch — far short of MAX_PAGES — so this exercises
  // the row bound specifically, distinct from the page-bound test above.
  const bigPage = { data: new Array(1_000_001).fill(0), nextCursor: 'still-going' };
  let fetches = 0;
  await assert.rejects(
    () =>
      drainPages<number>(async () => {
        fetches++;
        return bigPage;
      }),
    /exceeded the runaway guard/,
  );
  assert.ok(fetches <= 2, 'the row bound trips almost immediately, nowhere near MAX_PAGES');
});

test('drainPages does NOT throw on a huge but LEGITIMATELY FINAL page (guard checked after the terminal-cursor check)', async () => {
  // A page over the row bound whose nextCursor is falsy is a COMPLETE result, not a
  // partial one — however many rows it carries. The guard exists for a page that
  // wants to CONTINUE past these bounds, not for a normal last page that happens to
  // be large. Checking the guard before the null-cursor check would incorrectly
  // reject this legitimate, terminal, one-page result.
  const out = await drainPages<number>(async () => ({
    data: new Array(1_000_001).fill(1),
    nextCursor: null,
  }));
  assert.equal(out.length, 1_000_001, 'the full, complete page is returned — not rejected');
});
