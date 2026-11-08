/**
 * document_query — read document metadata, two modes (auto-detected by args):
 *
 *   field present → LOOKUP on a lookup-indexed field, one of:
 *                     • equality: `value`
 *                     • range:    `from` + `to`   (range-enabled fields)
 *                     • prefix:   `prefix`        (range-enabled string fields)
 *                   `type` (the document's bound schema type) is required here.
 *   no field      → LIST, optionally filtered by `type` (the bound schema type),
 *                     `folderId`, `userId` and `scope`. `type` is forwarded in this
 *                     mode too: dropping it would return documents of every type.
 *
 * Lookups route through `lookupDocumentsByBody` (POST), NOT the GET variant: the
 * POST body supports equality/range/prefix uniformly, is REQUIRED for SENSITIVE
 * lookup fields (the GET variant 400s — the value can't ride the URL), and never
 * leaks values into access/proxy logs. One path, no GET/POST branching.
 *
 * Result limits + pagination (the enumeration-limits contract, applied to every enumeration tool):
 *   • DEFAULT 3 — a low ceiling that protects the agent context window, since document
 *     metadata injects directly into it (token economy).
 *   • MAX 100 — the documents API max. Raise `limit` to pull a larger page in one call
 *     when you can accept the context cost; you are never forced to paginate.
 *   • PAGINATION — both list and lookup are cursor-paged. The result is the
 *     `{ data, nextCursor }` envelope; pass `nextCursor` back as `startFrom` for the next page.
 *   • MORE-REMAINS SIGNAL — a non-null `nextCursor` means more documents may remain; null
 *     means this was the last page. Never a silent cut.
 *
 * The `{ data, nextCursor }` page envelope (DocumentPage / DocumentLookupPage) is surfaced
 * directly so the cursor reaches the agent — matching folder_query / version_history.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { pageItems, type Page } from '../paging.js';

const MCP_DEFAULT_LIMIT = 3;
const MCP_MAX_LIMIT = 100;

const inputSchema = {
  // Lookup-mode args — provide `field` plus EXACTLY ONE of: value | from+to | prefix.
  field: z
    .string()
    .optional()
    .describe('Lookup mode: name of the lookup-indexed field to query by.'),
  value: z
    .string()
    .optional()
    .describe('Lookup mode (equality): exact-match value for `field`. Works on sensitive fields too.'),
  from: z
    .string()
    .optional()
    .describe('Lookup mode (range): inclusive lower bound; requires `to`. Range-enabled, non-sensitive fields only.'),
  to: z
    .string()
    .optional()
    .describe('Lookup mode (range): inclusive upper bound; requires `from`.'),
  prefix: z
    .string()
    .optional()
    .describe('Lookup mode (prefix): match values starting with this. Range-enabled string fields only.'),
  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe(
      'Lookup mode: sort direction by the looked-up field. `asc` (default) or `desc` — use `desc` with a range/' +
        'prefix lookup to get the most-recent / highest values first (e.g. latest-N). Refused without `field`.',
    ),
  type: z
    .string()
    .min(1, 'type must be non-empty: omit it to list every type')
    .optional()
    .describe(
      'The document type (the bound schema\'s type). Required with `field` (lookup mode); in list mode ' +
        'it narrows the list to documents of this type. The list filter applies page by page: a page can ' +
        'hold fewer documents than `limit`, or none, while `nextCursor` is set, so keep paging until ' +
        '`nextCursor` is null before concluding there are none. For a large collection, hybrid_search with ' +
        '`typeName` finds documents of one type directly.',
    ),
  // List-mode args (`type` above applies to both modes):
  folderId: z.string().optional().describe('List mode: only documents in this folder (Vectros folder id).'),
  userId: z.string().optional().describe('List mode: scope to documents owned by this user.'),
  scope: z
    .string()
    .optional()
    .describe(
      'List mode: filter to documents carrying this scope value, in `namespace:value` form ' +
        '(e.g. "org:<uuid>", "client:<uuid>", "group:eng-team"). `org` and `client` are reserved ' +
        'namespace names, registered like any other; others are namespaces you registered yourself.',
    ),
  startFrom: z
    .string()
    .optional()
    .describe('Pagination cursor — pass the `nextCursor` from the previous page to fetch the next. Works in both list and lookup mode.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(
      `Max documents per page. Defaults to a low ${MCP_DEFAULT_LIMIT} to protect the agent context ` +
        `window; raise up to ${MCP_MAX_LIMIT} (the documents API max) in one call when you can accept the ` +
        'larger payload, or page with `startFrom` instead.',
    ),
};

const documentQuery: ToolFactory = ({ client, log }) => ({
  name: 'document_query',
  title: 'Document query (list or lookup)',
  description:
    'Query document metadata. Two modes:\n' +
    '  • Lookup on a lookup-indexed field: pass `type` and `field` plus exactly one of ' +
    '`value` (exact), `from`+`to` (range), or `prefix`. Works on sensitive fields ' +
    '(equality only there); range/prefix need a range-enabled field.\n' +
    '  • List: omit `field`; optionally filter by `type`/`folderId`/`userId`/`scope` (`namespace:value`). ' +
    'The `type` filter is applied page by page, so a page can be short or empty while `nextCursor` is set: keep ' +
    'paging before concluding there are none.\n' +
    'Returns a `{ data, nextCursor }` page: `data` holds up to `limit` documents (default 3, max 100 — ' +
    'raise it in one call when you can accept the payload), and a non-null `nextCursor` means more remain — ' +
    'pass it back as `startFrom` to page. Mode is auto-detected. ' +
    'Use document_get for the full text/download URL of one document.',
  inputSchema,
  // A pure read — never creates, modifies, or deletes anything server-side.
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args): Promise<ToolResult> => {
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    const field = args.field as string | undefined;
    const value = args.value as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const prefix = args.prefix as string | undefined;
    const type = args.type as string | undefined;
    const startFrom = args.startFrom as string | undefined;
    try {
      let page: Page<Vectros.DocumentResponse>;
      if (field) {
        // Lookup mode — validate exactly one lookup shape, then require `type`.
        const hasEquality = value !== undefined;
        const hasRange = from !== undefined || to !== undefined;
        const hasPrefix = prefix !== undefined;
        const modes = Number(hasEquality) + Number(hasRange) + Number(hasPrefix);
        if (modes === 0) {
          return toolError(
            'document_query',
            new Error(
              `lookup on field '${field}' needs one of: 'value' (exact), 'from'+'to' (range), or 'prefix'.`,
            ),
          );
        }
        if (modes > 1) {
          return toolError(
            'document_query',
            new Error("'value', 'from'/'to', and 'prefix' are mutually exclusive — provide exactly one."),
          );
        }
        if (hasRange && !(from !== undefined && to !== undefined)) {
          return toolError('document_query', new Error("range lookup requires both 'from' and 'to'."));
        }
        if (type === undefined) {
          return toolError(
            'document_query',
            new Error("lookup requires 'type' (the document's bound schema type) alongside 'field'."),
          );
        }
        // POST-body lookup: sensitive-safe (value never in the URL), all modes in one path.
        page = await client.documents.lookupDocumentsByBody({
          type,
          field,
          value,
          from,
          to,
          prefix,
          order: args.order as 'asc' | 'desc' | undefined,
          startFrom,
          limit,
        });
        log.debug(
          { tool: 'document_query', mode: 'lookup', type, field, returned: pageItems(page).length },
          'document_query lookup ok',
        );
      } else {
        // List mode. A lookup argument without `field` would otherwise be dropped and the call
        // would quietly return an unfiltered list, so it is refused.
        const strayLookupArgs = (['value', 'from', 'to', 'prefix', 'order'] as const).filter(
          (k) => args[k] !== undefined,
        );
        if (strayLookupArgs.length > 0) {
          return toolError(
            'document_query',
            new Error(
              `Lookup arguments need 'field' (and 'type'): ${strayLookupArgs.map((k) => `'${k}'`).join(', ')}. ` +
                "Without 'field' the call lists documents: " +
                "filter the list with 'type', 'folderId', 'userId' or 'scope'.",
            ),
          );
        }
        // List mode — filter by type, folder and ownership.
        page = await client.documents.listDocuments({
          type,
          folderId: args.folderId as string | undefined,
          userId: args.userId as string | undefined,
          scope: args.scope as string | undefined,
          startFrom,
          limit,
        });
        log.debug(
          { tool: 'document_query', mode: 'list', type, limit, returned: pageItems(page).length },
          'document_query list ok',
        );
      }
      const documents = pageItems(page);
      const nextCursor = page.nextCursor ?? null;
      return { content: [{ type: 'text', text: JSON.stringify({ data: documents, nextCursor }, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'document_query', err: String(err) }, 'document_query failed');
      return toolError('document_query', err);
    }
  },
});

export default documentQuery;
