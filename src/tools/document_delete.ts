/**
 * document_delete — permanently delete a document by id. Wraps
 * `client.documents.deleteDocument()`.
 *
 * Scope-gated: the credential must allow `documents:d`. A key without it gets a
 * clean permission error (the tool returns isError, never tears down the
 * session). Deleting a document removes it and its indexed content.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  documentId: z.string().min(1, 'documentId is required').describe('The Vectros document id to delete.'),
};

const documentDelete: ToolFactory = ({ client, log }) => ({
  name: 'document_delete',
  title: 'Delete a document',
  description:
    'Permanently delete a document by id (removes it and its indexed content). Requires the key to allow ' +
    'documents:d — a key without it gets a permission error.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const documentId = args.documentId as string;
    try {
      await client.documents.deleteDocument({ id: documentId });
      log.debug({ tool: 'document_delete', documentId }, 'document_delete ok');
      return {
        content: [{ type: 'text', text: JSON.stringify({ deleted: true, id: documentId }, null, 2) }],
      };
    } catch (err) {
      log.warn({ tool: 'document_delete', documentId, err: String(err) }, 'document_delete failed');
      return toolError('document_delete', err);
    }
  },
});

export default documentDelete;
