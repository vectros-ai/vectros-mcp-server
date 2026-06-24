/**
 * record_create — create a structured record. Wraps `client.records.createRecord()`.
 *
 * The agent supplies the human-friendly `type` (typeName) and the server resolves
 * the schema from it (recordType is unique per tenant + context), so the agent
 * never carries schema ids and the tool makes a single round-trip — no schema
 * pre-fetch.
 *
 * Idempotent by `externalId`: re-creating with the same externalId returns the
 * existing record rather than duplicating.
 *
 * Requires the credential to allow `records:c` — a read-only key gets a clean
 * permission error (the tool never tears down the session).
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  type: z
    .string()
    .min(1, 'type is required')
    .describe('Record type / schema name (e.g. "task"). Must match an existing schema — see list_schemas.'),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      'The record payload — a JSON object of field→value, validated against the type schema. ' +
        'Call list_schemas to learn required fields, types, and enum values.',
    ),
  externalId: z
    .string()
    .optional()
    .describe(
      'Stable caller-supplied id. Immutable; unique per type. Re-creating with the same externalId ' +
        'returns the existing record (idempotent) — use it to make creates safely retryable.',
    ),
  indexMode: z
    .enum(['HYBRID', 'SEMANTIC', 'TEXT', 'NONE'])
    .optional()
    .describe(
      'Search-index strategy for this record, set at create only (immutable after). HYBRID (BM25 + dense), ' +
        'SEMANTIC (dense only), TEXT (BM25 only), NONE (store-only — never appears in hybrid_search/rag_ask; ' +
        'still retrievable by id and structured-field lookup). Omit to inherit the type schema\'s default; if ' +
        'the schema default is NONE and you want this record searchable, set it here — it cannot be changed later.',
    ),
  status: z.string().optional().describe('Record lifecycle status. Defaults to ACTIVE server-side.'),
  folderId: z.string().optional().describe('Group this record into a folder.'),
  userId: z.string().optional().describe('Owning user id.'),
  orgId: z.string().optional().describe('Owning organization id.'),
  clientId: z.string().optional().describe('Associated client id.'),
};

const recordCreate: ToolFactory = ({ client, log }) => ({
  name: 'record_create',
  title: 'Create a record',
  description:
    'Create a structured record of a given type. Provide `type` and `fields` (the payload, validated ' +
    'against the type schema — call list_schemas first to learn required fields and enums). Idempotent ' +
    'by `externalId`. Requires the key to allow records:c.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const type = args.type as string;
    try {
      // The server resolves the schema from `typeName` — pass it directly, no
      // schemaId pre-fetch. An unknown type returns a clean 4xx from the API.
      const created = await client.records.createRecord({
        typeName: type,
        payload: args.fields as Record<string, unknown>,
        externalId: args.externalId as string | undefined,
        indexMode: args.indexMode as 'HYBRID' | 'SEMANTIC' | 'TEXT' | 'NONE' | undefined,
        status: args.status as string | undefined,
        folderId: args.folderId as string | undefined,
        userId: args.userId as string | undefined,
        orgId: args.orgId as string | undefined,
        clientId: args.clientId as string | undefined,
      });
      log.debug({ tool: 'record_create', type, id: created.id }, 'record_create ok');
      return { content: [{ type: 'text', text: JSON.stringify(created, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'record_create', type, err: String(err) }, 'record_create failed');
      return toolError('record_create', err);
    }
  },
});

export default recordCreate;
