/**
 * rag_ask — wraps `client.inference.ragInference(...)` → `POST /v1/rag`.
 *
 * RAG generation can take 30-45s (longer with Opus). MCP clients
 * have tool-execution timeouts that fire well inside that window.
 *
 * Two mechanisms keep this tool reliable:
 *   1. SSE deltas are aggregated into a single final response (MCP
 *      tools are request/response — they don't natively stream).
 *   2. Per `content_delta` we emit an MCP `notifications/progress`
 *      to keep the JSON-RPC connection warm so the client doesn't
 *      timeout the tool call before we return.
 *
 * See the design doc § "Long-running tool calls" for
 * the architectural rule.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { consumeStream, type SseEvent } from '../sse.js';
import { toolError } from './errors.js';

const SEARCH_MCP_DEFAULT_LIMIT = 5;
const SEARCH_MCP_MAX_LIMIT = 10;

const inputSchema = {
  query: z.string().min(1, 'query must be non-empty').describe('Question to ground against retrieved content.'),
  instructions: z
    .string()
    .optional()
    .describe(
      'System prompt that overrides the default for the generation step — e.g. "answer only from the provided ' +
        'context, cite sources, be concise". Default: a generic answer-from-context instruction.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Inference model alias (e.g. claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-8). ' +
        'Default = tier-appropriate Haiku. See GET /v1/models for the catalog the calling key can reach.',
    ),
  search: z
    .object({
      mode: z.enum(['HYBRID', 'TEXT', 'SEMANTIC']).optional().describe('Retrieval mode. Default HYBRID.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(SEARCH_MCP_MAX_LIMIT)
        .optional()
        .describe(`Passages to retrieve before generating. Default ${SEARCH_MCP_DEFAULT_LIMIT}, max ${SEARCH_MCP_MAX_LIMIT}.`),
      // Retrieval scoping — parity with hybrid_search so an agent can ground the
      // answer on a specific owner / folder / type / metadata subset, not just the
      // whole-tenant corpus.
      userId: z.string().optional().describe('Restrict retrieval to content owned by this user (Vectros UUID).'),
      orgId: z.string().optional().describe('Restrict retrieval to content owned by this org (Vectros UUID).'),
      clientId: z.string().optional().describe('Restrict retrieval to content tagged with this client (Vectros UUID).'),
      folderId: z.string().optional().describe('Restrict retrieval to this exact folder.'),
      rootFolderId: z.string().optional().describe('Restrict retrieval to this folder and all its descendants.'),
      typeName: z.string().optional().describe('Restrict record retrieval to this schema type.'),
      contentTypes: z
        .array(z.enum(['documents', 'records']))
        .optional()
        .describe('Narrow retrieval to content types. ["documents"] or ["records"]; omit for both.'),
      filters: z
        .record(z.unknown())
        .optional()
        .describe(
          'Field-level metadata filters (AND-combined). Value = scalar (equality), array (OR-set), or operator ' +
            'map ($eq/$ne/$gt/$gte/$lt/$lte, $in/$nin). e.g. {"status":"open"}.',
        ),
      createdAfter: z.string().optional().describe('Restrict to content created at/after this ISO 8601 UTC timestamp.'),
      createdBefore: z.string().optional().describe('Restrict to content created at/before this ISO 8601 UTC timestamp.'),
      requireComplete: z
        .boolean()
        .optional()
        .describe('Fail closed (503) on a degraded search backend instead of grounding on partial results. Default false.'),
    })
    .optional()
    .describe('Retrieval params + scoping. Default mode HYBRID, limit ' + SEARCH_MCP_DEFAULT_LIMIT + '.'),
  maxTokens: z.number().int().min(1).optional().describe('Max output tokens.'),
  temperature: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Sampling temperature (0.0–1.0). Default 0.3 — lower favors deterministic, retrieval-grounded answers.'),
};

const ragAsk: ToolFactory = ({ client, log }) => ({
  name: 'rag_ask',
  title: 'RAG ask (corpus-wide)',
  description:
    'Ask a question grounded against the partner tenant\'s indexed content. ' +
    'Vectros performs a hybrid search, injects the top-K passages into the prompt, ' +
    'and streams a model answer back. Scope retrieval with `search` (ownership, folder, type, metadata filters, ' +
    'date window) to ground on a subset — e.g. one patient or one folder — and steer generation with ' +
    '`instructions` / `temperature`. The full answer is returned as a single response; ' +
    'progress notifications keep the call alive during the 30-45s generation window. ' +
    'Inference runs in-perimeter against AWS Bedrock — PHI never leaves the BAA boundary.',
  inputSchema,
  handler: async (args, extra): Promise<ToolResult> => {
    try {
      const searchArg = (args.search ?? {}) as {
        mode?: 'HYBRID' | 'TEXT' | 'SEMANTIC';
        limit?: number;
        userId?: string;
        orgId?: string;
        clientId?: string;
        folderId?: string;
        rootFolderId?: string;
        typeName?: string;
        contentTypes?: Array<'documents' | 'records'>;
        filters?: Record<string, unknown>;
        createdAfter?: string;
        createdBefore?: string;
        requireComplete?: boolean;
      };
      const search: Vectros.RagSearch = {
        mode: searchArg.mode ?? 'HYBRID',
        limit: searchArg.limit ?? SEARCH_MCP_DEFAULT_LIMIT,
        userId: searchArg.userId,
        orgId: searchArg.orgId,
        clientId: searchArg.clientId,
        folderId: searchArg.folderId,
        rootFolderId: searchArg.rootFolderId,
        typeName: searchArg.typeName,
        contentTypes: searchArg.contentTypes as Vectros.RagSearch.ContentTypes.Item[] | undefined,
        filters: searchArg.filters as Record<string, Vectros.FilterValue> | undefined,
        createdAfter: searchArg.createdAfter,
        createdBefore: searchArg.createdBefore,
        requireComplete: searchArg.requireComplete,
      };
      const stream = (await client.inference.ragInference({
        query: args.query as string,
        instructions: args.instructions as string | undefined,
        model: args.model as string | undefined,
        search,
        maxTokens: args.maxTokens as number | undefined,
        temperature: args.temperature as number | undefined,
      })) as AsyncIterable<SseEvent>;

      const progressToken = extra._meta?.progressToken;
      const onProgress = progressToken !== undefined && extra.sendNotification
        ? async (chunk: { text: string; total: number }) => {
            await extra.sendNotification!({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: chunk.total,
                message: chunk.text,
              },
            });
          }
        : undefined;

      const aggregated = await consumeStream(stream, onProgress);

      log.debug(
        {
          tool: 'rag_ask',
          answerLength: aggregated.answer.length,
          usage: aggregated.usage,
        },
        'rag_ask ok',
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                answer: aggregated.answer,
                searchResults: aggregated.searchResults,
                truncationWarning: aggregated.truncationWarning,
                usage: aggregated.usage,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      log.warn({ tool: 'rag_ask', err: String(err) }, 'rag_ask failed');
      return toolError(
        'rag_ask',
        err,
        'https://docs.vectros.ai/feature-inference#known-limitations',
      );
    }
  },
});

export default ragAsk;
