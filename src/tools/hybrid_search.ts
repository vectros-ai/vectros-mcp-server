/**
 * hybrid_search — wraps `client.search.content(...)` → `POST /v1/search`.
 *
 * Result limits + pagination (the enumeration-limits contract):
 *   default limit = 3   — a low ceiling: a tool result injects directly into the LLM
 *                         context window, and contextText-heavy hits are ~1k tokens each.
 *   max limit     = 50  — the search API max (the engine caps a page at 50). Raise `limit`
 *                         to pull more in one call when you can accept the cost; the
 *                         per-response byte budget still trims an oversized tail.
 *
 * Pagination is via `offset`; `totalResults` (the full matching pool) drives an explicit
 * `hasMore` flag so an agent knows when more results remain past the current page.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const MCP_DEFAULT_LIMIT = 3;
const MCP_MAX_LIMIT = 50;
// Keep a single tool-result well under a typical MCP client's result cap so one search can't blow the
// agent's context window. contextText (the broad passage per hit) is the heavy part and is omitted by
// default (opt in with includeContext); this budget is the backstop for everything else. Measured as
// serialized-string LENGTH (JS UTF-16 code units) — an approximation of bytes, deliberately conservative
// (it's a soft backstop, not an exact limit).
const MCP_RESPONSE_CHAR_BUDGET = 24_000;
const SNIPPET_MAX_CHARS = 160;
// Search-index bookkeeping keys that repeat on every hit and carry no agent value — stripped from the
// MCP payload so they don't crowd the context. The caller's own ingested metadata is always kept.
const INTERNAL_METADATA_KEYS = new Set(['tenantId', 'owner_id', 'model_type', 'rootFolderId', 'folderId']);

/** Drop internal search-index bookkeeping keys from a hit's metadata, preserving caller-supplied fields. */
function trimMetadata(md: unknown): unknown {
  if (!md || typeof md !== 'object' || Array.isArray(md)) return md;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(md as Record<string, unknown>)) {
    if (!INTERNAL_METADATA_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Reshape one search hit for agent consumption: trim internal metadata; omit the heavy
 * contextText unless opted in (and, when included, drop the now-redundant chunkText it already
 * contains); and populate the agent-sized snippet from the matched chunk when the server left it empty.
 */
function reshapeHit(hit: Record<string, unknown>, includeContext: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...hit };
  if ('metadata' in out) out.metadata = trimMetadata(out.metadata);
  const chunk = typeof hit.chunkText === 'string' ? hit.chunkText : undefined;
  const ctx = typeof hit.contextText === 'string' ? hit.contextText : undefined;
  if (includeContext) {
    if (chunk && ctx && ctx.includes(chunk)) delete out.chunkText; // dedupe: send only the container
  } else {
    delete out.contextText; // compact default — the matched chunk is the retrieval unit
  }
  if ((out.snippet == null || out.snippet === '') && chunk) {
    out.snippet = chunk.length > SNIPPET_MAX_CHARS ? chunk.slice(0, SNIPPET_MAX_CHARS) + '…' : chunk;
  }
  return out;
}

const inputSchema = {
  query: z.string().min(1, 'query must be non-empty').describe('Natural-language or keyword query.'),
  mode: z
    .enum(['HYBRID', 'TEXT', 'SEMANTIC'])
    .optional()
    .describe('HYBRID (BM25 + dense, default), TEXT (BM25 only), or SEMANTIC (dense only).'),
  textMode: z
    .enum(['OR', 'AND', 'PHRASE'])
    .optional()
    .describe(
      'Keyword-match precision for the BM25 leg (TEXT/HYBRID modes). OR = any term (broad recall), ' +
        'AND = all terms (higher precision), PHRASE = contiguous phrase. Default: PHRASE (slop 3) in HYBRID, ' +
        'OR in TEXT. (The advanced raw-query COMPLEX mode is intentionally not exposed here.)',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(
      `Max hits per page. Defaults to a low ${MCP_DEFAULT_LIMIT} to protect the agent context ` +
        `window; raise up to ${MCP_MAX_LIMIT} (the most a single search returns) in one call when you can ` +
        'accept the larger result, or page with `offset` instead.',
    ),
  offset: z.number().int().min(0).max(200).optional().describe('Skip the first N hits — for pagination (0–200).'),
  folderId: z.string().optional().describe('Scope to content in this EXACT folder (Vectros folder id).'),
  rootFolderId: z
    .string()
    .optional()
    .describe('Scope to content under this folder AND all its descendants (subtree-root folder id).'),
  // Content narrowing.
  contentTypes: z
    .array(z.enum(['documents', 'records']))
    .optional()
    .describe('Narrow to content types. ["documents"] or ["records"]; omit for unified (both).'),
  typeName: z
    .string()
    .optional()
    .describe(
      'Restrict hits to this schema type (e.g. "patient", "runbook"). Applies to BOTH documents and ' +
        'records — combine with contentTypes to scope within one content type. Untyped content never matches.',
    ),
  filters: z
    .record(z.unknown())
    .optional()
    .describe(
      'Field-level metadata filters (AND-combined). Value = scalar (equality), array (OR-set), or ' +
        'operator map: $eq/$ne/$gt/$gte/$lt/$lte (scalar) or $in/$nin (array). ' +
        'e.g. {"status":"open"} or {"price":{"$gte":100,"$lte":500}}.',
    ),
  // Ownership.
  userId: z.string().optional().describe('Restrict to content owned by this user (Vectros UUID).'),
  orgId: z.string().optional().describe('Restrict to content belonging to this org (Vectros UUID).'),
  clientId: z.string().optional().describe('Restrict to content associated with this client (Vectros UUID).'),
  scope: z
    .string()
    .optional()
    .describe(
      'Restrict to content carrying this scope value, in `namespace:value` form (e.g. "org:<uuid>", ' +
        '"group:eng-team"). `scope=org:<id>`/`scope=client:<id>` are equivalent to the orgId/clientId filters.',
    ),
  // Date window.
  createdAfter: z
    .string()
    .optional()
    .describe('Restrict to content created at/after this ISO 8601 UTC timestamp.'),
  createdBefore: z
    .string()
    .optional()
    .describe('Restrict to content created at/before this ISO 8601 UTC timestamp.'),
  // Relevance tuning.
  minSimilarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum semantic similarity (0.0–1.0); results below are excluded.'),
  minTextRelevance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum relative keyword (BM25) relevance (0.0–1.0); the keyword-leg analogue of minSimilarity.'),
  uniqueDocuments: z
    .boolean()
    .optional()
    .describe('When true, return at most one chunk per source document.'),
  includeContext: z
    .boolean()
    .optional()
    .describe(
      'Include the broader passage (contextText) around each matched chunk. Off by default to keep the ' +
        'result compact — each hit returns its matched chunkText plus a short snippet. Turn this on only ' +
        'when you need more surrounding context inline; for a full deep read, fetch the source with document_get.',
    ),
  requireComplete: z
    .boolean()
    .optional()
    .describe(
      'When true, fail closed (HTTP 503) if a search backend is unavailable rather than silently returning ' +
        'partial/degraded results. Default false (degrade to the surviving engine; the result still flags degraded).',
    ),
};

const hybridSearch: ToolFactory = ({ client, log }) => ({
  name: 'hybrid_search',
  title: 'Hybrid search',
  description:
    'Search your tenant\'s indexed content (documents + structured records) using hybrid BM25 + dense ranking. ' +
    'Returns up to `limit` results (default 3, max 50 — raise it in one call when you can accept the larger result) ' +
    'with citations and surrounding context for grounding follow-up reasoning. ' +
    'Narrow with contentTypes/typeName/filters, ownership (userId/orgId/clientId), folder scope, a created date window, ' +
    'keyword precision (textMode OR/AND/PHRASE), relevance floors (minSimilarity/minTextRelevance), uniqueDocuments, ' +
    'and requireComplete (fail closed on a degraded backend). Tenant-isolated; the caller\'s scoped key fully ' +
    'constrains which content is visible. ARCHIVED (soft-retracted) documents never appear in results — fetch ' +
    'them by id via document_get, or restore them via document_update. To stay within the agent context window each hit returns its matched ' +
    'chunkText + a short snippet by default; set includeContext:true for the broader surrounding passage. If the ' +
    'whole result would be too large it is truncated to the top hits (truncated:true). totalResults is the full ' +
    'matching pool and hasMore:true means results remain past this page — raise limit or advance offset to fetch them. ' +
    'textLegEmpty:true flags that ' +
    'the keyword leg matched nothing (all textScores 0) — usually a too-long PHRASE query; retry with textMode:"OR".',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    const mode = (args.mode as 'HYBRID' | 'TEXT' | 'SEMANTIC' | undefined) ?? 'HYBRID';
    try {
      const result = await client.search.content({
        query: args.query as string,
        mode,
        textMode: args.textMode as Vectros.SearchRequest.TextMode | undefined,
        limit,
        offset: args.offset as number | undefined,
        folderId: args.folderId as string | undefined,
        rootFolderId: args.rootFolderId as string | undefined,
        contentTypes: args.contentTypes as Vectros.SearchRequest.ContentTypes.Item[] | undefined,
        typeName: args.typeName as string | undefined,
        filters: args.filters as Record<string, Vectros.FilterValue> | undefined,
        userId: args.userId as string | undefined,
        orgId: args.orgId as string | undefined,
        clientId: args.clientId as string | undefined,
        scope: args.scope as string | undefined,
        createdAfter: args.createdAfter as string | undefined,
        createdBefore: args.createdBefore as string | undefined,
        minSimilarity: args.minSimilarity as number | undefined,
        minTextRelevance: args.minTextRelevance as number | undefined,
        uniqueDocuments: args.uniqueDocuments as boolean | undefined,
        requireComplete: args.requireComplete as boolean | undefined,
      });
      const hits: Array<Record<string, unknown>> = Array.isArray(
        (result as { results?: unknown }).results,
      )
        ? (result as { results: Array<Record<string, unknown>> }).results
        : [];
      const includeContext = (args.includeContext as boolean | undefined) ?? false;
      let shaped = hits.map((h) => reshapeHit(h, includeContext));

      // Keyword-leg diagnostic: in a HYBRID/TEXT search, if every hit scored 0 on the BM25
      // (keyword) leg, that leg contributed nothing — a common trap when a long natural-language query
      // runs under the PHRASE default. Flag it so the agent can re-shape the query or switch textMode
      // rather than silently trusting a semantic-only ranking.
      const textLegEmpty =
        mode !== 'SEMANTIC' && hits.length > 0 && hits.every((h) => !(Number(h.textScore) > 0));

      const envelope: Record<string, unknown> = {
        ...(result as Record<string, unknown>),
        results: shaped,
      };
      if (textLegEmpty) envelope.textLegEmpty = true;

      // Per-response size budget: a single search must not overflow the agent's context window.
      // Drop hits from the least-relevant tail until the serialized result fits, flagging the truncation
      // (mirrors the `degraded` signal). Keeps at least the top hit.
      let text = JSON.stringify(envelope, null, 2);
      while (shaped.length > 1 && text.length > MCP_RESPONSE_CHAR_BUDGET) {
        shaped = shaped.slice(0, -1);
        envelope.results = shaped;
        envelope.truncated = true;
        envelope.returnedResults = shaped.length;
        text = JSON.stringify(envelope, null, 2);
      }

      // Explicit more-remains signal: totalResults is the full matching pool. Computed from the
      // FINAL returned count (after any size-budget truncation) so it is the single authoritative "there
      // is more to fetch" flag — it fires whenever the agent hasn't seen the whole pool, whether the
      // shortfall is the `limit` ceiling, the `offset` window, or a locally-trimmed tail. Advance `offset`
      // (or raise `limit`) to fetch the rest. Only asserted when the backend reported totalResults.
      const offset = (args.offset as number | undefined) ?? 0;
      const totalResults = (result as { totalResults?: unknown }).totalResults;
      if (typeof totalResults === 'number' && offset + shaped.length < totalResults) {
        envelope.hasMore = true;
        text = JSON.stringify(envelope, null, 2);
      }

      log.debug(
        { tool: 'hybrid_search', mode, limit, returned: shaped.length, textLegEmpty },
        'hybrid_search ok',
      );
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      log.warn({ tool: 'hybrid_search', err: String(err) }, 'hybrid_search failed');
      return toolError('hybrid_search', err);
    }
  },
});

export default hybridSearch;
