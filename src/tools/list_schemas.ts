/**
 * list_schemas — wraps `client.schemas.listSchemas()` → `GET /v1/schemas`.
 *
 * Makes `record_query` discoverable: the agent calls `list_schemas`
 * first to learn what record types exist (and which fields are
 * lookup-indexed for exact-match queries), then constructs a valid
 * `record_query` call against one of them.
 *
 * Args are optional ownership filters that pass through to the SDK.
 * Default behavior (no args) returns every schema the credential can
 * see — scoped by AccessProfile for `ssk_*` keys.
 *
 * As of SDK 0.23 `listSchemas` returns the `{ data, nextCursor }` page
 * envelope (page size 20, server-capped at 100) — not a bare array. We
 * DRAIN every page (schemas are small metadata objects; the full catalog
 * fits agent context) and serialize the flat `SchemaResponse[]`, preserving
 * the v0.1/v0.2 bare-array agent contract across the envelope change. See
 * src/paging.ts.
 *
 * No MCP-specific result cap applies — unlike record_query/hybrid_search,
 * the full schema catalog is the point of this tool.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { drainPages } from '../paging.js';

const inputSchema = {
  userId: z
    .string()
    .optional()
    .describe(
      'Filter to schemas visible to a specific user. Optional; default returns all schemas the credential can see.',
    ),
  orgId: z
    .string()
    .optional()
    .describe(
      'Filter to schemas visible to a specific org. Optional; default returns all schemas the credential can see.',
    ),
  surface: z
    .enum(['record', 'document', 'user', 'org', 'client'])
    .optional()
    .describe(
      'Filter to schemas bindable to this surface — e.g. `document` to list only document types, or `record` ' +
        'for record types. The identity surfaces (user/org/client) are account-wide. Optional.',
    ),
  recordType: z
    .string()
    .optional()
    .describe(
      'Resolve the single schema for this record type (its natural handle, e.g. "patient") instead of listing — ' +
        'returns a one-element result, or empty if none. Combine with `surface=user|org|client` for an identity ' +
        'schema. Takes precedence over userId/orgId. Optional.',
    ),
};

const listSchemas: ToolFactory = ({ client, log }) => ({
  name: 'list_schemas',
  title: 'List record schemas',
  description:
    'List the structured-record schema catalog for the partner tenant. ' +
    'Each schema describes a record type (e.g. "patient", "clinical_note") — its fields, lookup-indexed fields, and capabilities. ' +
    'Use this to discover what record types exist before calling `record_query`. ' +
    'Filter with `surface` (record/document/user/org/client — e.g. only document types), `recordType` (resolve ' +
    'one schema by its type name), or `userId`/`orgId`; default returns everything the credential can see.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const userId = args.userId as string | undefined;
    const orgId = args.orgId as string | undefined;
    const surface = args.surface as 'record' | 'document' | 'user' | 'org' | 'client' | undefined;
    const recordType = args.recordType as string | undefined;
    try {
      // Drain the paged envelope into the full catalog (flat array).
      const schemas = await drainPages<Vectros.SchemaResponse>((startFrom) =>
        client.schemas.listSchemas({ userId, orgId, surface, recordType, startFrom }),
      );
      log.debug(
        { tool: 'list_schemas', userId, orgId, surface, recordType, returned: schemas.length },
        'list_schemas ok',
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(schemas, null, 2) }],
      };
    } catch (err) {
      log.warn({ tool: 'list_schemas', err: String(err) }, 'list_schemas failed');
      return toolError('list_schemas', err);
    }
  },
});

export default listSchemas;
