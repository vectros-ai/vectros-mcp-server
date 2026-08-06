/**
 * Pagination helpers for the `{ data, nextCursor }` page envelope.
 *
 * As of SDK 0.23 (surface-freeze), the
 * list/lookup partner-API methods — `schemas.listSchemas`,
 * `records.listRecords`, `records.lookupRecords` — return this paged envelope
 * rather than a bare array. The MCP tools serialize their result straight into
 * the agent's context window, so we unwrap the envelope here to keep the
 * agent-facing output a flat array (the v0.1/v0.2 contract) and absorb the
 * shape change in exactly one, unit-tested place.
 *
 * These are pure helpers (no SDK/IO coupling — the caller injects the
 * page-fetcher), so they're the unit-test target rather than the tool
 * handlers' SDK plumbing.
 */

/** The paged-response envelope: a page of items + an opaque next-page cursor. */
export interface Page<T> {
  /** Items on this page, in the endpoint's natural order. Empty (or absent) when no results. */
  data?: T[] | undefined;
  /** Opaque cursor for the next page; null/absent when no more pages remain. Treat as opaque. */
  nextCursor?: (string | null) | undefined;
}

/** Unwrap a single page to its items — the agent-facing bare array. */
export function pageItems<T>(page: Page<T>): T[] {
  return page.data ?? [];
}

// Runaway guards for drainPages — sized to never trip on a legitimate catalog
// (schemas are small tenant-scoped metadata; even a huge tenant is nowhere
// near these), so in normal operation neither bound should bind at all. They
// exist for the empty-page pathology below, not to cap real work — see the
// "why a row-only guard is not enough" note on drainPages.
//
// MAX_PAGES is the one that actually matters for that pathology: an empty
// page with a live cursor never grows `all.length`, so only the page bound
// can trip. It must be low enough that the error is still reachable before
// an MCP client's own request timeout — 10,000 sequential round-trips (the
// original bound here) never gets there in practice, which made the "stops
// with a clear error" guarantee true only in the limit. 100 pages is still
// two orders of magnitude past any real schema catalog (page size 20-100 →
// up to 10,000 schemas) while actually surfacing the error to a live caller.
const MAX_PAGES = 100;
const MAX_ROWS = 1_000_000;

/**
 * Drain every page of a cursor-paginated endpoint into one flat array.
 *
 * `fetchPage(startFrom)` fetches a single page; the previous page's
 * `nextCursor` is fed back as the next `startFrom`. The loop terminates on a
 * FALSY `nextCursor` (null / undefined / empty string) — never on an empty
 * `data` array. That distinction matters: terminating on page *fullness*
 * instead of cursor *nullity* is exactly the bug that infinite-loops the old
 * `getAllResults()`-style iterators under the 0.23 null-cursor semantics
 * (a non-full final page legitimately carries a null cursor).
 *
 * Bounded on BOTH pages and accumulated rows, not rows alone. A row-only
 * guard (`if (all.length > MAX) throw`) is unreachable on exactly the
 * pathology it exists for: a page can come back EMPTY while `nextCursor`
 * stays live — a per-page `filterByDataScope` post-filter dropping every row,
 * or a partition scanned with no matches — so the row count never grows and
 * never trips. The loop advances on the CURSOR; the guard must bound the
 * thing the loop actually advances on. Fails closed (throws) rather than
 * returning a partial catalog — a caller handed a partial answer from a
 * silently-tripped bound is back to the truncation this envelope replaced.
 */
export async function drainPages<T>(
  fetchPage: (startFrom?: string) => Promise<Page<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let startFrom: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(startFrom);
    pages++;
    // A plain loop, not `all.push(...page.data)` — spreading a very large array as
    // call arguments can blow the stack (RangeError), which is exactly the wrong
    // failure mode one line above the guard meant to fail closed cleanly.
    if (page.data?.length) for (const item of page.data) all.push(item);
    const next = page.nextCursor;
    if (!next) break;
    // Guard AFTER the terminal-cursor check, never before: a page that is both
    // huge and legitimately the LAST one (nextCursor falsy) must still return —
    // it is a complete result, not a partial one, however many rows it carries.
    // Only a page that wants to CONTINUE past these bounds is the runaway case.
    if (pages > MAX_PAGES || all.length > MAX_ROWS) {
      throw new Error(
        `drainPages: exceeded the runaway guard (${all.length} rows over ${pages} pages, ` +
          `limits ${MAX_ROWS}/${MAX_PAGES}) without the cursor going null. Refusing to return ` +
          'a partial result — the backend may be returning empty pages with a live cursor.',
      );
    }
    startFrom = next;
  }
  return all;
}
