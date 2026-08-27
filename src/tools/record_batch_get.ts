/**
 * record_batch_get — fetch several structured records by id in one call.
 * Wraps `client.records.batchGetRecords()` (0.41.0: previously a `501` stub,
 * now live).
 *
 * Complements record_get: use record_get for a single id (or an
 * externalId+type lookup), and record_batch_get when you already hold
 * several ids — e.g. hydrating the full payloads for a page of
 * record_query/hybrid_search results — to avoid N round-trips.
 *
 * The API silently omits any id you can't access (nonexistent, wrong
 * account, or outside your token's scope) rather than erroring, with no
 * per-id existence signal. This tool surfaces that as a `missingIds` array
 * (every requested id not present in the response) so a caller can tell a
 * partial result from a complete one without diffing it by hand.
 *
 * Payloads are hydrated in full (same as record_get, unlike the
 * indexed-projection record_query/hybrid_search return), so the same
 * per-record truncation guard applies to protect the agent context window.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

// ~8k tokens per record; mirrors record_get's / document_get's truncation cap.
const MAX_PAYLOAD_CHARS = 32_000;
// The API's own batch-get cap (BatchGetRequest.ids).
const MCP_MAX_IDS = 100;

const inputSchema = {
  ids: z
    .array(z.string())
    .min(1)
    .max(MCP_MAX_IDS)
    .describe(
      `Record ids to fetch in one call (1-${MCP_MAX_IDS}). Any id you cannot access — nonexistent, ` +
        "wrong account, or outside your token's scope — is silently omitted from the response (no " +
        'per-id existence signal); compare against the response\'s `missingIds` to see which requested ' +
        'ids came back empty.',
    ),
};

const recordBatchGet: ToolFactory = ({ client, log }) => ({
  name: 'record_batch_get',
  title: 'Get multiple records by id in one call',
  description:
    'Fetch several structured records by id in a single call (1-100 ids), each with its full payload — ' +
    'the same hydration record_get gives a single id. Use this instead of N record_get calls when you ' +
    "already hold several ids (e.g. a page of record_query/hybrid_search results). Any id you can't " +
    'access is silently omitted from `data`; the response also returns `missingIds` — every requested ' +
    "id not present in `data` — so you can tell a partial result from a complete one. As with record_get, " +
    'an oversized payload is truncated into a labelled `payloadPreview` rather than shipped whole.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const ids = args.ids as string[];
    try {
      const response = await client.records.batchGetRecords({ ids });
      const records: Vectros.RecordResponse[] = response.data ?? [];
      const data = records.map((record) => {
        const item: Record<string, unknown> = { ...record };
        if (record.payload !== undefined) {
          const json = JSON.stringify(record.payload);
          if (json.length > MAX_PAYLOAD_CHARS) {
            // Same rationale as record_get: never ship a sliced JSON string in
            // the structured `payload` slot — it would be invalid JSON.
            delete item.payload;
            item.payloadPreview = json.slice(0, MAX_PAYLOAD_CHARS);
            item.payloadTruncated = true;
            item.payloadTotalChars = json.length;
          }
        }
        return item;
      });
      const returnedIds = new Set(records.map((r) => r.id));
      const missingIds = ids.filter((id) => !returnedIds.has(id));
      log.debug(
        { tool: 'record_batch_get', requested: ids.length, returned: data.length, missing: missingIds.length },
        'record_batch_get ok',
      );
      return { content: [{ type: 'text', text: JSON.stringify({ data, missingIds }, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'record_batch_get', idsCount: ids?.length, err: String(err) }, 'record_batch_get failed');
      return toolError('record_batch_get', err);
    }
  },
});

export default recordBatchGet;
