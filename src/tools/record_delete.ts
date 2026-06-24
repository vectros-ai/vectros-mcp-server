/**
 * record_delete — permanently delete a record by id. Wraps
 * `client.records.deleteRecord()` (leaves a tombstone server-side).
 *
 * Scope-gated: the credential must allow `records:d`. A key without it gets a
 * clean permission error (the tool returns isError, never tears down the
 * session). The flagship blueprints deliberately omit records:d, so hard-delete
 * is dark there by default — for archive/soft-delete use record_update to set
 * the record `status` instead.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  id: z.string().min(1, 'id is required').describe('The Vectros record id to delete.'),
};

const recordDelete: ToolFactory = ({ client, log }) => ({
  name: 'record_delete',
  title: 'Delete a record',
  description:
    'Permanently delete a record by id (leaves a tombstone). Requires the key to allow records:d — a key ' +
    'without it gets a permission error. To archive without deleting, use record_update to set status instead.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const id = args.id as string;
    try {
      await client.records.deleteRecord({ id });
      log.debug({ tool: 'record_delete', id }, 'record_delete ok');
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, id }, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'record_delete', id, err: String(err) }, 'record_delete failed');
      return toolError('record_delete', err);
    }
  },
});

export default recordDelete;
