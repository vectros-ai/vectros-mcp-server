/**
 * version_history — read the change/audit trail for a record or document. Wraps
 * `client.records.getRecordVersions()` / `client.documents.getDocumentVersions()`.
 *
 * Returns the version entries (CREATE / UPDATE / DELETE, with actor + timestamp +
 * the per-change diff) for one entity, so an agent can answer "what changed and
 * when" without leaving the tool surface. History is recorded only for entities
 * bound to a schema with audit history enabled (the default for typed records /
 * documents); an untyped entity has no history and returns an empty trail.
 *
 * The trail can be long, so — like folder_query — this exposes the page cursor:
 * the result is `{ data, nextCursor }`; pass `nextCursor` back as `startFrom` to
 * walk older entries. Requires the relevant read scope (`records:r` /
 * `documents:r`).
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { pageItems } from '../paging.js';

const inputSchema = {
  resourceType: z
    .enum(['record', 'document'])
    .describe('Which kind of entity the id refers to: a record or a document.'),
  id: z.string().min(1, 'id is required').describe('The Vectros id of the record or document whose history you want.'),
  startFrom: z
    .string()
    .optional()
    .describe('Pagination cursor — pass the `nextCursor` from the previous page to fetch older entries.'),
};

const versionHistory: ToolFactory = ({ client, log }) => ({
  name: 'version_history',
  title: 'Version history (record or document)',
  description:
    'Read the audit/version trail (CREATE/UPDATE/DELETE, with actor, timestamp, and diff) for a single record ' +
    'or document. Pass `resourceType` (record|document) and `id`. Returns `{ data, nextCursor }`; pass ' +
    '`nextCursor` back as `startFrom` to page through older entries. Entities without audit history (untyped) ' +
    'return an empty trail. Read-only.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const resourceType = args.resourceType as 'record' | 'document';
    const id = args.id as string;
    const startFrom = args.startFrom as string | undefined;
    try {
      const page: Vectros.ModelDataVersionPage =
        resourceType === 'record'
          ? await client.records.getRecordVersions({ id, startFrom })
          : await client.documents.getDocumentVersions({ id, startFrom });
      const versions = pageItems(page);
      const nextCursor = page.nextCursor ?? null;
      log.debug(
        { tool: 'version_history', resourceType, id, returned: versions.length },
        'version_history ok',
      );
      return { content: [{ type: 'text', text: JSON.stringify({ data: versions, nextCursor }, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'version_history', resourceType, id, err: String(err) }, 'version_history failed');
      return toolError('version_history', err);
    }
  },
});

export default versionHistory;
