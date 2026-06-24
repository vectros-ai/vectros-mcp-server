/**
 * record_update — update a record's fields. Wraps `client.records.patchRecord()`
 * (RFC-7386 JSON Merge Patch).
 *
 * The caller's `fields` are sent as the patch payload: the server DEEP-MERGES
 * them into the stored payload — keys you send overwrite (recursing into nested
 * objects), a key set to `null` is deleted, and keys you omit are preserved. No
 * read-modify-write and no race window (contrast the old GET-then-full-replace).
 * `typeName`/`schemaId` are immutable and must not be sent on a patch.
 *
 * Optimistic concurrency: pass the `version` you last read as `expectedVersion`.
 * If the record changed since, the server rejects with a 409 conflict — re-read
 * (record_get) and retry. Omit `expectedVersion` for last-write-wins.
 *
 * Requires the credential to allow `records:u`.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  id: z.string().min(1, 'id is required').describe('The Vectros record id to update.'),
  fields: z
    .record(z.string(), z.unknown())
    .describe(
      'Field→value changes DEEP-MERGED into the existing payload: keys you send overwrite (recursing into ' +
        'nested objects), a key set to `null` is deleted, and unspecified fields are preserved.',
    ),
  status: z
    .string()
    .optional()
    .describe('Set the record lifecycle status (e.g. ARCHIVED) — archive/workflow without physical deletion.'),
  expectedVersion: z
    .number()
    .int()
    .optional()
    .describe(
      'Optimistic concurrency: the version you last read. If the record changed since, the update is ' +
        'refused as a conflict (re-read and retry). Omit for last-write-wins.',
    ),
};

const recordUpdate: ToolFactory = ({ client, log }) => ({
  name: 'record_update',
  title: 'Update a record',
  description:
    'Update a record by id. The provided `fields` are DEEP-MERGED into the existing payload (unspecified ' +
    'fields are preserved; a field set to `null` is deleted). Pass `expectedVersion` (the version you last ' +
    'read) for safe concurrent edits — a stale update is refused (409). Use `status` to archive without ' +
    'deleting. Requires the key to allow records:u.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const id = args.id as string;
    const fields = args.fields as Record<string, unknown>;
    const status = args.status as string | undefined;
    const expectedVersion = args.expectedVersion as number | undefined;
    try {
      // RFC-7386 merge-patch: send only what's changing. typeName/schemaId are
      // immutable and rejected if present, so they are intentionally omitted.
      const body: Vectros.RecordRequest = { payload: fields };
      if (status !== undefined) body.status = status;
      if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;

      const updated = await client.records.patchRecord({ id, body });
      log.debug({ tool: 'record_update', id }, 'record_update ok');
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'record_update', id, err: String(err) }, 'record_update failed');
      return toolError('record_update', err);
    }
  },
});

export default recordUpdate;
