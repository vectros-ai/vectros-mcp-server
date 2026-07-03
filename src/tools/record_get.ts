/**
 * record_get — fetch one structured record by id, including its full payload.
 * Wraps `client.records.getRecord()`.
 *
 * Complements record_query / hybrid_search (which return the indexed
 * projection): use record_get when you have an id and need the complete record.
 * A very large payload is truncated to protect the agent context window — the
 * same token-economy guard document_get applies to document text. When that
 * happens the structured `payload` is dropped and replaced with a `payloadPreview`
 * string + `payloadTruncated: true` + `payloadTotalChars`, so the truncated value
 * is never an invalid-JSON string masquerading as the object payload.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { resolveRecordIdByExternalId } from './resolve-external-id.js';

// ~8k tokens; mirrors document_get's text cap.
const MAX_PAYLOAD_CHARS = 32_000;

const inputSchema = {
  id: z
    .string()
    .optional()
    .describe('The Vectros record id (e.g. from record_query or hybrid_search). Provide this OR externalId+type.'),
  externalId: z
    .string()
    .optional()
    .describe(
      'Your caller-owned externalId — an alternative selector to `id`. Requires `type` (externalId is unique ' +
        'within a type). Resolves to the record without a manual record_query lookup first.',
    ),
  type: z
    .string()
    .optional()
    .describe('Record type — REQUIRED when selecting by `externalId` (externalId is unique within a type).'),
};

const recordGet: ToolFactory = ({ client, log }) => ({
  name: 'record_get',
  title: 'Get a record by id or externalId',
  description:
    'Fetch a single structured record, including the full payload. Select it EITHER by its Vectros `id` ' +
    '(e.g. from record_query / hybrid_search) OR by your own `externalId` + `type` — the same key you passed ' +
    'to record_create, resolved for you (no manual record_query lookup needed). ' +
    'Very large payloads are truncated to protect the agent context window.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const id = args.id as string | undefined;
    const externalId = args.externalId as string | undefined;
    const type = args.type as string | undefined;
    try {
      const resolved = await resolveRecordIdByExternalId(client, { id, externalId, type });
      if ('error' in resolved) return toolError('record_get', new Error(resolved.error));
      const record = await client.records.getRecord({ id: resolved.id });
      const out: Record<string, unknown> = { ...record };
      if (record.payload !== undefined) {
        const json = JSON.stringify(record.payload);
        if (json.length > MAX_PAYLOAD_CHARS) {
          // Don't ship a sliced JSON string in the structured `payload` slot — it
          // would be invalid JSON and mislead a consumer that expects an object.
          // Mirror document_get's text handling: drop the oversized payload and
          // surface a clearly-labelled string preview + a truncation flag.
          delete out.payload;
          out.payloadPreview = json.slice(0, MAX_PAYLOAD_CHARS);
          out.payloadTruncated = true;
          out.payloadTotalChars = json.length;
        }
      }
      log.debug(
        { tool: 'record_get', id: resolved.id, externalId, truncated: out.payloadTruncated === true },
        'record_get ok',
      );
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'record_get', id, externalId, type, err: String(err) }, 'record_get failed');
      return toolError('record_get', err);
    }
  },
});

export default recordGet;
