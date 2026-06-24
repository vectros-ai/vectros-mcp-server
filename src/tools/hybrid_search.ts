/**
 * hybrid_search — wraps `client.search.content(...)` → `POST /v1/search`.
 *
 * MCP-specific limits (smaller than the underlying API defaults):
 *   default limit = 3
 *   max limit     = 10
 *
 * Why: a tool's JSON result is injected directly into the LLM's
 * context window. The API default of 10 hits × ~1k tokens of
 * contextText each = 10k tokens injected per call. With the API max
 * of 50, that's 50k tokens — blows past most model windows and costs
 * the user a fortune. See the design doc § "Token economy".
 *
 * Agents that need more results paginate via `offset`.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const MCP_DEFAULT_LIMIT = 3;
const MCP_MAX_LIMIT = 10;

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
      `Max hits to return. MCP-specific cap of ${MCP_MAX_LIMIT} (vs API max of 50) to protect ` +
        'the agent context window. Default 3. Use offset for pagination.',
    ),
  offset: z.number().int().min(0).optional().describe('Skip the first N hits — for pagination.'),
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
    .describe('Restrict record hits to this schema type (e.g. "patient"). No-op for documents.'),
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
    'Search the partner tenant\'s indexed content (documents + structured records) using hybrid BM25 + dense ranking. ' +
    'Returns up to 10 results (default 3) with citations and surrounding context for grounding follow-up reasoning. ' +
    'Narrow with contentTypes/typeName/filters, ownership (userId/orgId/clientId), folder scope, a created date window, ' +
    'keyword precision (textMode OR/AND/PHRASE), relevance floors (minSimilarity/minTextRelevance), uniqueDocuments, ' +
    'and requireComplete (fail closed on a degraded backend). Tenant-isolated; the caller\'s scoped key fully ' +
    'constrains which content is visible.',
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
        createdAfter: args.createdAfter as string | undefined,
        createdBefore: args.createdBefore as string | undefined,
        minSimilarity: args.minSimilarity as number | undefined,
        minTextRelevance: args.minTextRelevance as number | undefined,
        uniqueDocuments: args.uniqueDocuments as boolean | undefined,
        requireComplete: args.requireComplete as boolean | undefined,
      });
      log.debug(
        { tool: 'hybrid_search', mode, limit, returned: result.results?.length },
        'hybrid_search ok',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      log.warn({ tool: 'hybrid_search', err: String(err) }, 'hybrid_search failed');
      return toolError('hybrid_search', err);
    }
  },
});

export default hybridSearch;
