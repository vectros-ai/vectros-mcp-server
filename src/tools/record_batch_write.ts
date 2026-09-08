/**
 * record_batch_write — create (or upsert) up to 50 records in one call.
 * Wraps `client.records.batchWriteRecords()` (API 0.43.0: previously a `501`
 * stub, now live — the same shape `record_batch_get` was adopted in for 0.41.0).
 *
 * Complements record_create: use record_create for one record, and this when
 * you hold several — e.g. filing a parsed table, or seeding a set of tasks —
 * to avoid N round-trips.
 *
 * Item vocabulary deliberately mirrors record_create (`type` + `fields`, not
 * `typeName` + `payload`), so an agent that has learned record_create carries
 * that knowledge over unchanged. Each item goes through EXACTLY the same
 * validation, `externalId` idempotency, unique-field enforcement and scope check
 * as a single `POST /v1/records`, with `records:c:<type>` applied PER ITEM
 * against that item's own type: a batch is not a way to write a type the
 * credential could not write one at a time.
 *
 * Two things about this endpoint an agent will get wrong unless told:
 *
 *   1. The HTTP status is 200 whenever the batch was PROCESSED — including when
 *      every single item failed. The per-item `results` array is the real
 *      outcome, and it is NOT guaranteed to arrive in submission order, so a
 *      caller correlates through each result's `index`. This tool is therefore
 *      NOT an `isError` result on a partial or total item failure: the CALL
 *      succeeded, and the per-item outcomes are data. The description says so
 *      explicitly because an agent that branches on isError alone would read a
 *      wholly failed batch as a success — and because record_create, the tool
 *      this one generalizes, reports its failures the opposite way.
 *   2. `all_or_nothing` is bounded by underlying STORAGE ROWS, not by item
 *      count, so a batch inside the 50-item limit can still be refused as too
 *      large to commit atomically. Nothing is written when that happens.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

// The API's own cap, identical for both atomicity modes (BatchWriteRequest.items).
const MCP_MAX_ITEMS = 50;

// .strict() so an unknown per-item key is REJECTED rather than silently dropped. The
// server applies .strict() to the tool's top-level shape for exactly this reason ("a
// strict rejection self-corrects the agent immediately; a silent wrong result does
// not"), but that does not reach inside a nested object. It matters here because the
// API's own record shape carries fields this tool does not map — `expiresAt` (a TTL),
// `schemaId`, `expectedVersion` — so without this an agent could set a TTL on 50
// records, be told `created`, and get 50 records that never expire.
const itemSchema = z.strictObject({
  type: z
    .string()
    .min(1, 'type is required')
    .describe('Record type / schema name (e.g. "task"). Must match an existing schema — see list_schemas.'),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      'The record payload — a JSON object of field→value, validated against the type schema. ' +
        'Same rules as record_create, including the signed 64-bit range on numbers (send a larger ' +
        'whole number as a STRING).',
    ),
  externalId: z
    .string()
    .optional()
    .describe(
      'Stable caller-supplied id, unique per type — supply it to make a batch safely retryable, since ' +
        'without one a re-submitted item creates a second record. Without `upsert`, an item whose ' +
        'externalId already matches a COMMITTED record comes back `updated` (the idempotent repeat — ' +
        'nothing was overwritten) if your credential can read that type; a create-only credential gets ' +
        '`conflict` instead, because it may not be shown the existing record. ⚠️ Two items sharing ONE ' +
        'externalId WITHIN a single batch are only refused as a `conflict` under ' +
        'atomicity:"all_or_nothing". Under the DEFAULT best_effort each item is written independently, so ' +
        'the second matches what the first just wrote and reports `updated` — a duplicate key in your ' +
        'input silently collapses two rows into one, counted in `succeeded`, not in `failed`. ' +
        'De-duplicate by externalId before sending, or use all_or_nothing if you need the batch to ' +
        'refuse. A result returns the record\'s `id`, not the record itself; fetch that with ' +
        'record_get/record_batch_get.',
    ),
  indexMode: z
    .enum(['HYBRID', 'SEMANTIC', 'TEXT', 'NONE'])
    .optional()
    .describe(
      'Search-index strategy for this record, set at create only and NOT changeable later. HYBRID ' +
        '(BM25 + dense), SEMANTIC (dense only), TEXT (BM25 only), NONE (store-only — the record never ' +
        'appears in hybrid_search/rag_ask, though it stays retrievable by id and by structured-field ' +
        "lookup). Omit to inherit the type schema's default; if that default is NONE and you want these " +
        'records searchable, set it here, because it cannot be fixed after the write.',
    ),
  status: z.string().optional().describe('Record lifecycle status. Defaults to ACTIVE server-side.'),
  folderId: z.string().optional().describe('Group this record into a folder.'),
  userId: z.string().optional().describe('Owning user id.'),
  scopes: z
    .array(z.string())
    .optional()
    .describe(
      'Scope ownership as `namespace:value` entries, at most 2 namespaces. When supplied this is the ' +
        "record's COMPLETE scope declaration, and each entry must fall inside the `data_scope` of a " +
        'single clause of your credential that also grants this write — your identity supplies the ' +
        'DEFAULT when you state none, it does not limit which value you may state. `[]` creates a ' +
        "PRIVATE record owned by the calling user alone. Omit to inherit the credential's full identity.",
    ),
});

const inputSchema = {
  items: z
    .array(itemSchema)
    .min(1)
    .max(MCP_MAX_ITEMS)
    .describe(
      `The records to write, 1-${MCP_MAX_ITEMS}. Each item is shaped like a record_create call ` +
        '(`type` + `fields`, plus the same optional externalId/indexMode/status/folderId/userId/scopes) ' +
        'and is validated and scope-checked individually against its OWN type — items may mix types.',
    ),
  atomicity: z
    .enum(['best_effort', 'all_or_nothing'])
    .optional()
    .describe(
      'How the batch commits. "best_effort" (the default) writes each item independently — some can ' +
        'succeed while others fail. "all_or_nothing" commits every item in ONE transaction: if any item ' +
        'fails nothing is written at all, and the items that were themselves fine report status ' +
        '"not_committed". Choose all_or_nothing when the records are interdependent or a half-written ' +
        'set would be worse than none; note it can still be refused as too large to commit atomically ' +
        'even within the item limit, because that transaction is bounded by underlying storage rows ' +
        'rather than by item count (nothing is written when that happens).',
    ),
  upsert: z
    .boolean()
    .optional()
    .describe(
      'Applies to every item: when true, an item whose `externalId` already exists OVERWRITES that ' +
        'record instead of returning it unchanged. Needs records:u:<type> in addition to records:c:<type>, ' +
        'checked per item. Default false.',
    ),
  allowClear: z
    .boolean()
    .optional()
    .describe(
      'Only meaningful with upsert:true, which overwrites as a FULL replacement. If an item\'s `fields` ' +
        'omits (or nulls) a stored field that only comes back as an indexed projection — a large record ' +
        'whose payload is stored externally — the overwrite is refused unless you set this to true to ' +
        'confirm you mean to clear those fields. Default false. To change some fields without clearing ' +
        'the omitted ones, use record_update instead of an upserting batch.',
    ),
};

const recordBatchWrite: ToolFactory = ({ client, log }) => ({
  name: 'record_batch_write',
  title: 'Create or upsert multiple records in one call',
  description:
    'Write up to 50 structured records in a single call — use this instead of N record_create calls when ' +
    'you hold several records (e.g. filing a parsed table, or seeding a set of tasks). Items may mix ' +
    'types; each one is schema-validated, externalId-idempotent and scope-checked individually against ' +
    'its own type (records:c:<type> per item), so a batch cannot write a type you could not write one at ' +
    'a time. `atomicity` chooses the commit shape: "best_effort" (default) writes each item independently; ' +
    '"all_or_nothing" commits every item in one transaction, writing nothing at all if any item fails — ' +
    'prefer it when a half-written set would be worse than none. ' +
    'IMPORTANT: this call reports success whenever the batch was PROCESSED, including when every item ' +
    'failed — so always read the per-item `results` and the `succeeded`/`failed` counts rather than ' +
    'treating a non-error result as "all written". This differs from record_create, where a failure is ' +
    'an error result. Results are NOT guaranteed to arrive in the order you submitted: match each one ' +
    'to its item by its `index` (zero-based, the position in your `items` array). A result carries the ' +
    "written record's `id` (null on failure) and, when it failed, an `error` with a machine-readable " +
    '`code` and a human-readable `message` — read it before resubmitting. It does NOT carry the record ' +
    'itself; fetch that with record_get/record_batch_get. A per-item `status` is created (new record ' +
    'written), updated (an existing record matched — overwritten only if you passed upsert:true, ' +
    'otherwise returned unchanged, so this is not by itself evidence of a write), conflict (uniqueness ' +
    'or version), invalid (validation — read `error.message` for which field), forbidden (your ' +
    'credential lacks the scope or ownership that item needed — fix the credential, not the item), or ' +
    'not_committed (this item was fine but an all_or_nothing batch was aborted by a different item, so ' +
    'resubmitting with that one fixed writes this one unchanged).',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const items = args.items as Array<{
      type: string;
      fields: Record<string, unknown>;
      externalId?: string;
      indexMode?: 'HYBRID' | 'SEMANTIC' | 'TEXT' | 'NONE';
      status?: string;
      folderId?: string;
      userId?: string;
      scopes?: string[];
    }>;
    const atomicity = args.atomicity as Vectros.BatchWriteRequest.Atomicity | undefined;
    try {
      // Map the agent-facing vocabulary onto the wire shape. The server resolves the schema from
      // `typeName`, exactly as record_create relies on — no schemaId pre-fetch per item.
      const body: Vectros.BatchWriteRequest = {
        items: items.map((item) => ({
          typeName: item.type,
          payload: item.fields,
          externalId: item.externalId,
          indexMode: item.indexMode,
          status: item.status as Vectros.RecordRequest.Status | undefined,
          folderId: item.folderId,
          userId: item.userId,
          scopes: item.scopes,
        })),
        atomicity,
        upsert: args.upsert as boolean | undefined,
        allowClear: args.allowClear as boolean | undefined,
      };
      // maxRetries: 0 is REQUIRED here, not a tuning choice. The SDK retries any
      // 408/429/5xx by replaying the whole request body, and a best_effort batch commits
      // its items independently — so a rate limit or write-freeze raised partway through
      // arrives AFTER earlier items are already committed, and the platform deliberately
      // lets those account-level conditions propagate as a whole-request error rather
      // than translating them into per-item outcomes. A replay would therefore re-write
      // everything that had already landed: 30 submitted items can become 36 rows, and
      // only items carrying an `externalId` are protected by idempotency. Retrying a
      // partially-committed batch has to be the caller's decision, made against the
      // per-item `results` it can no longer see once the request as a whole failed.
      const response = await client.records.batchWriteRecords(body, { maxRetries: 0 });
      log.debug(
        {
          tool: 'record_batch_write',
          submitted: items.length,
          atomicity: atomicity ?? 'best_effort',
          succeeded: response.succeeded,
          failed: response.failed,
        },
        'record_batch_write ok',
      );
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    } catch (err) {
      log.warn(
        { tool: 'record_batch_write', itemCount: items?.length, err: String(err) },
        'record_batch_write failed',
      );
      return toolError('record_batch_write', err);
    }
  },
});

export default recordBatchWrite;
