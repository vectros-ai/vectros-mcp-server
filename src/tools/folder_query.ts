/**
 * folder_query — read folders, two modes (auto-detected by args):
 *
 *   id present → GET one folder (`getFolder`) → single FolderResponse object.
 *   no id      → LIST (`listFolders`): direct children of `parentId` (tree
 *                navigation) or a flat tenant list; optional ownership filters.
 *                → `{ data: FolderResponse[], nextCursor }`. Unlike the
 *                record/document list tools, folder listing exposes the page
 *                cursor: folders are small, navigation is the point, and a
 *                tenant can hold more folders than one page — so silently
 *                truncating the tree would lose folders with no way to reach
 *                them. Pass the returned `nextCursor` back as `startFrom`.
 *
 * MCP-specific limit (smaller than the API default): default 10 / max 50 —
 * folder rows are small (no payload), so the cap is looser than records/docs
 * but still bounded for the agent context window.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { pageItems } from '../paging.js';

const MCP_DEFAULT_LIMIT = 10;
const MCP_MAX_LIMIT = 50;

const inputSchema = {
  id: z.string().optional().describe('Get mode: fetch this single folder by id.'),
  parentId: z
    .string()
    .optional()
    .describe('List mode: direct children of this folder (tree navigation). Omit for a flat tenant list.'),
  userId: z.string().optional().describe('List mode: scope to folders owned by this user.'),
  orgId: z.string().optional().describe('List mode: scope to folders belonging to this org.'),
  clientId: z.string().optional().describe('List mode: scope to folders associated with this client.'),
  startFrom: z
    .string()
    .optional()
    .describe('List mode: pagination cursor — pass the `nextCursor` from the previous page to fetch the next.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(`List mode: max folders to return. MCP cap of ${MCP_MAX_LIMIT} (vs API 100). Default 10.`),
};

const folderQuery: ToolFactory = ({ client, log }) => ({
  name: 'folder_query',
  title: 'Folder query (list or get)',
  description:
    'Read folders. Two modes:\n' +
    '  • Get: pass `id` → returns the single folder.\n' +
    '  • List: omit `id`; pass `parentId` for a folder\'s direct children (tree navigation) or omit for a ' +
    'flat tenant list. Optionally filter by `userId`/`orgId`/`clientId`.\n' +
    'List mode returns `{ data, nextCursor }` (default 10, max 50 per page); pass `nextCursor` back as ' +
    '`startFrom` to page through all folders. Get mode returns the single folder object.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const id = args.id as string | undefined;
    try {
      if (id) {
        const folder = await client.folders.getFolder({ id });
        log.debug({ tool: 'folder_query', mode: 'get', id }, 'folder_query get ok');
        return { content: [{ type: 'text', text: JSON.stringify(folder, null, 2) }] };
      }
      const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
      const page = await client.folders.listFolders({
        parentFolderId: args.parentId as string | undefined,
        userId: args.userId as string | undefined,
        orgId: args.orgId as string | undefined,
        clientId: args.clientId as string | undefined,
        startFrom: args.startFrom as string | undefined,
        limit,
      });
      const folders: Vectros.FolderResponse[] = pageItems(page);
      const nextCursor = page.nextCursor ?? null;
      log.debug({ tool: 'folder_query', mode: 'list', limit, returned: folders.length }, 'folder_query list ok');
      return { content: [{ type: 'text', text: JSON.stringify({ data: folders, nextCursor }, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'folder_query', err: String(err) }, 'folder_query failed');
      return toolError('folder_query', err);
    }
  },
});

export default folderQuery;
