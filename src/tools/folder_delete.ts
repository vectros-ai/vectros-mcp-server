/**
 * folder_delete — permanently delete a folder by id. Wraps
 * `client.folders.deleteFolder()`.
 *
 * Scope-gated: the credential must allow `folders:d`. A key without it gets a
 * clean permission error. Protected folders (e.g. a context root, isProtected:
 * true) cannot be deleted — the API rejects it and the tool surfaces the error.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  id: z.string().min(1, 'id is required').describe('The Vectros folder id to delete.'),
};

const folderDelete: ToolFactory = ({ client, log }) => ({
  name: 'folder_delete',
  title: 'Delete a folder',
  description:
    'Permanently delete a folder by id. Requires the key to allow folders:d — a key without it gets a ' +
    'permission error. Protected folders (e.g. a context root) cannot be deleted.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const id = args.id as string;
    try {
      await client.folders.deleteFolder({ id });
      log.debug({ tool: 'folder_delete', id }, 'folder_delete ok');
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, id }, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'folder_delete', id, err: String(err) }, 'folder_delete failed');
      return toolError('folder_delete', err);
    }
  },
});

export default folderDelete;
