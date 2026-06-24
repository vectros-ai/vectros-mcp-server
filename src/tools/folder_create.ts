/**
 * folder_create — create a folder. Wraps `client.folders.createFolder()`.
 *
 * Idempotent by `slug` within (tenant, context, parent): the slug is the
 * idempotency key for blueprint-declared folders and is derived from the name
 * when omitted. `parentId` places the folder under a parent (create-only — a
 * folder cannot be moved later via the API).
 *
 * Requires the credential to allow `folders:c`.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  name: z.string().min(1, 'name is required').describe('Folder display name.'),
  description: z.string().optional().describe('Optional description of the folder\'s purpose.'),
  parentId: z
    .string()
    .optional()
    .describe('Parent folder id — places the folder under this parent. Omit for the context default root. Create-only.'),
  slug: z
    .string()
    .optional()
    .describe('Optional stable slug (sibling-unique; idempotency key). Lowercase letters/digits/hyphens. Derived from name when omitted.'),
  userId: z.string().optional().describe('Owning user (Vectros UUID).'),
  orgId: z.string().optional().describe('Owning org (Vectros UUID).'),
  clientId: z.string().optional().describe('Associated client (Vectros UUID).'),
};

const folderCreate: ToolFactory = ({ client, log }) => ({
  name: 'folder_create',
  title: 'Create a folder',
  description:
    'Create a folder to organize documents and records. Pass `parentId` to nest it (create-only — folders ' +
    'cannot be moved later). Idempotent by `slug` within the parent. Requires the key to allow folders:c.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    try {
      const folder = await client.folders.createFolder({
        name: args.name as string,
        description: args.description as string | undefined,
        parentFolderId: args.parentId as string | undefined,
        slug: args.slug as string | undefined,
        userId: args.userId as string | undefined,
        orgId: args.orgId as string | undefined,
        clientId: args.clientId as string | undefined,
      });
      log.debug({ tool: 'folder_create', id: folder.id, name: folder.name }, 'folder_create ok');
      return { content: [{ type: 'text', text: JSON.stringify(folder, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'folder_create', err: String(err) }, 'folder_create failed');
      return toolError('folder_create', err);
    }
  },
});

export default folderCreate;
