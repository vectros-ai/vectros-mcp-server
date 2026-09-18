/**
 * folder_delete — permanently delete a folder by id. Wraps
 * `client.folders.deleteFolder()`.
 *
 * Scope-gated: the credential must allow `folders:d`. A key without it gets a
 * clean permission error. Protected folders (e.g. a context root, isProtected:
 * true) cannot be deleted — the API rejects it and the tool surfaces the error.
 *
 * The folder must also be EMPTY — no documents, no records, and no sub-folders.
 * API 0.43.0 widened this considerably, and the widening matters more here than
 * it does to most callers: the old guard saw sub-folders and FILE-BACKED
 * documents only, and was blind to TEXT-INGESTED documents and to records. A
 * delete that hit one of those returned 204 and orphaned the contents behind a
 * folderId that no longer resolved; it is now refused. Text-inline ingest is
 * this server's own default document path (document_ingest), so folders this
 * server filled are exactly the ones whose deletes used to succeed and now do
 * not. This is the most common way the call fails, so the description states it
 * rather than leaving an agent to infer that "protected" is the only refusal.
 *
 * One trap the description cannot fully solve: the emptiness guard counts
 * EVERYTHING in the folder, including items the calling credential cannot read.
 * A scoped credential can therefore be refused by content it has no way to
 * enumerate. That is deliberate upstream (the alternative deletes data you were
 * not allowed to see), but it means "I listed the folder and it looked empty"
 * is not a contradiction of the refusal.
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
    'Permanently delete a folder by id. The folder must be EMPTY first — it must contain no documents, ' +
    'no records, and no sub-folders — and a non-empty folder is refused, which is the most common way ' +
    'this call fails. Use record_query with this folderId, and document_query, to see what is in it. ' +
    'Clearing it differs by content type: a document can be moved out (document_update with a different ' +
    'folderId) or deleted. A RECORD can also be re-filed into another folder — the API supports it — but ' +
    'THIS SERVER does not expose that yet: record_update has no folderId argument, so from here your only ' +
    'option is record_delete (needs records:d). Do NOT read that as "the record cannot be moved" and ' +
    'delete partner data on that basis: if the record should be kept, move it with the Vectros API/SDK ' +
    'directly rather than deleting it here. A sub-folder cannot be re-parented at all, so nested folders ' +
    'have to be emptied and deleted innermost-first. Note the emptiness check counts everything in the ' +
    'folder, INCLUDING items your ' +
    'credential cannot read — so a refusal you cannot account for from what you can list is expected ' +
    'behaviour, not a bug, and retrying will not clear it. Requires the key to allow folders:d — a key ' +
    'without it gets a permission error. Protected folders (e.g. a context root) cannot be deleted at ' +
    'all, however empty.',
  inputSchema,
  // Deletes. Idempotent in the standard REST sense: the end state ("this id no longer
  // resolves") is the same whether this is the first delete or a repeat of one.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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
