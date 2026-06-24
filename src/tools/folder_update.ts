/**
 * folder_update — rename / re-describe / re-own a folder. Wraps
 * `client.folders.patchFolder()` (RFC-7386 JSON Merge Patch), consistent with
 * record_update / document_update.
 *
 * PATCH semantics (from the SDK contract):
 *   • Top-level fields (`name`, `description`, ownership) are SET when present
 *     and left unchanged when omitted; sending one as `null` is rejected.
 *   • `parentFolderId` is set at CREATE only and IGNORED on update — a folder
 *     cannot be moved via the API (so this tool exposes no move arg).
 *
 * Using PATCH (not the full-replacement PUT) means the body doesn't require
 * `name`, so — unlike a PUT — there's no read-to-carry-name-forward round-trip.
 *
 * Optimistic concurrency: pass the `version` you last read as `expectedVersion`.
 * If the folder changed since, the server rejects with a 409 conflict (re-read
 * via folder_query and retry). Omit for last-write-wins.
 *
 * Requires the credential to allow `folders:u`.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  id: z.string().min(1, 'id is required').describe('The Vectros folder id to update.'),
  name: z.string().optional().describe('New folder name. Omit to keep the current name.'),
  description: z.string().optional().describe('New description. Omit to leave unchanged.'),
  userId: z.string().optional().describe('Reassign the owning user (Vectros UUID).'),
  orgId: z.string().optional().describe('Reassign the owning org (Vectros UUID).'),
  clientId: z.string().optional().describe('Reassign the associated client (Vectros UUID).'),
  expectedVersion: z
    .number()
    .int()
    .optional()
    .describe(
      'Optimistic concurrency: the version you last read. If the folder changed since, the update is refused ' +
        'as a conflict (re-read and retry). Omit for last-write-wins.',
    ),
};

const folderUpdate: ToolFactory = ({ client, log }) => ({
  name: 'folder_update',
  title: 'Update a folder',
  description:
    'Update a folder\'s name / description / ownership by id (RFC-7386 merge — omitted fields preserved). Pass ' +
    '`expectedVersion` (the version you last read) for safe concurrent edits — a stale update is refused (409). ' +
    'Folders cannot be moved (re-parenting is not supported by the API). Requires the key to allow folders:u.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const id = args.id as string;
    const name = args.name as string | undefined;
    const description = args.description as string | undefined;
    const userId = args.userId as string | undefined;
    const orgId = args.orgId as string | undefined;
    const clientId = args.clientId as string | undefined;
    const expectedVersion = args.expectedVersion as number | undefined;
    try {
      // RFC-7386 merge-patch: send only what's changing — no read-to-carry-name
      // forward (PATCH doesn't require name). The shared FolderRequest type marks
      // `name` required (it is for PUT), so the patch body is assembled untyped
      // and cast at the call, mirroring document_update.
      const body: Partial<Vectros.FolderRequest> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (userId !== undefined) body.userId = userId;
      if (orgId !== undefined) body.orgId = orgId;
      if (clientId !== undefined) body.clientId = clientId;
      if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;

      const updated = await client.folders.patchFolder({ id, body: body as Vectros.FolderRequest });
      log.debug({ tool: 'folder_update', id }, 'folder_update ok');
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'folder_update', id, err: String(err) }, 'folder_update failed');
      return toolError('folder_update', err);
    }
  },
});

export default folderUpdate;
