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
 */
export async function drainPages<T>(
  fetchPage: (startFrom?: string) => Promise<Page<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let startFrom: string | undefined;
  for (;;) {
    const page = await fetchPage(startFrom);
    if (page.data?.length) all.push(...page.data);
    const next = page.nextCursor;
    if (!next) break;
    startFrom = next;
  }
  return all;
}
