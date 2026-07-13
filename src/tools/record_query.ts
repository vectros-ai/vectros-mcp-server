/**
 * record_query — read structured records, two modes (auto-detected by args):
 *
 *   field present → LOOKUP on a lookup-indexed field, one of:
 *                     • equality: `value`
 *                     • range:    `from` + `to`
 *                     • prefix:   `prefix`
 *   no field      → LIST by type (+ optional ownership filters)
 *
 * Lookups route through `lookupRecordsByBody` (POST /v1/records/lookup), NOT the
 * GET variant: the POST body supports equality/range/prefix uniformly, is the
 * REQUIRED path for SENSITIVE lookup fields (the GET variant 400s — the value
 * can't ride the URL query string), and never leaks values into access/proxy
 * logs. One path, no GET/POST branching, no sensitivity sniffing.
 *
 * Result limits + pagination (the enumeration-limits contract, applied to every enumeration tool):
 *   • DEFAULT 3 — a low ceiling that protects the agent context window, since records
 *     inject directly into it (token economy; see the design doc § "Token economy").
 *   • MAX 100 — the records API max. An agent that accepts the context cost can raise
 *     `limit` to pull a larger page in a single call; it is never forced to paginate.
 *   • PAGINATION — both list and lookup are cursor-paged. The result is the
 *     `{ data, nextCursor }` envelope; pass the returned `nextCursor` back as
 *     `startFrom` to fetch the next page.
 *   • MORE-REMAINS SIGNAL — a non-null `nextCursor` means the page filled and more
 *     records may remain; null means this was the last page. Never a silent cut.
 *
 * SDK 0.23 returns the `{ data, nextCursor }` page envelope for both `listRecords`
 * and `lookupRecordsByBody`; we surface it directly (rather than unwrapping to a bare
 * array) so the cursor reaches the agent — matching folder_query / version_history.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { pageItems, type Page } from '../paging.js';

const MCP_DEFAULT_LIMIT = 3;
const MCP_MAX_LIMIT = 100;

const inputSchema = {
  type: z
    .string()
    .min(1, 'type (record type) is required')
    .describe('Record type / schema name (e.g. "patient", "clinical_note").'),
  // Lookup-mode args — provide `field` plus EXACTLY ONE of: value | from+to | prefix.
  field: z
    .string()
    .optional()
    .describe(
      'Lookup mode: name of the lookup-indexed field to query by. `externalId` is always queryable — ' +
        'e.g. `{type:"control", field:"externalId", value:"ctrl-scoped-key"}` finds the record you created ' +
        'under that externalId. (record_get / record_update also accept externalId directly.)',
    ),
  value: z.string().optional().describe('Lookup mode (equality): exact-match value for `field`.'),
  from: z
    .string()
    .optional()
    .describe('Lookup mode (range): inclusive lower bound; requires `to`. Non-sensitive fields only.'),
  to: z
    .string()
    .optional()
    .describe('Lookup mode (range): inclusive upper bound; requires `from`.'),
  prefix: z
    .string()
    .optional()
    .describe('Lookup mode (prefix): match values starting with this. String, non-sensitive fields only.'),
  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe(
      'Lookup mode: sort direction by the looked-up field. `asc` (default) or `desc` — use `desc` with a range/' +
        'prefix lookup to get the most-recent / highest values first (e.g. latest-N). Ignored in list mode.',
    ),
  // List-mode args:
  userId: z.string().optional().describe('List mode: scope to records owned by this user.'),
  orgId: z.string().optional().describe('List mode: scope to records owned by this org.'),
  clientId: z.string().optional().describe('List mode: scope to records associated with this client.'),
  scope: z
    .string()
    .optional()
    .describe(
      'List mode: filter to records carrying this scope value, in `namespace:value` form ' +
        '(e.g. "org:<uuid>", "group:eng-team"). `scope=org:<id>`/`scope=client:<id>` are equivalent ' +
        'to the orgId/clientId filters.',
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
      `Max records per page. Defaults to a low ${MCP_DEFAULT_LIMIT} to protect the agent context ` +
        `window; raise up to ${MCP_MAX_LIMIT} (the records API max) in one call when you can accept the ` +
        'larger payload, or page with `startFrom` instead.',
    ),
};

const recordQuery: ToolFactory = ({ client, log }) => ({
  name: 'record_query',
  title: 'Record query (list or lookup)',
  description:
    'Query structured records of a given type. Two modes:\n' +
    '  • Lookup on a lookup-indexed field: pass `field` plus exactly one of `value` (exact), ' +
    '`from`+`to` (range), or `prefix`. Works on sensitive fields too.\n' +
    '  • List by type: omit `field`; optionally filter by `userId`/`orgId`/`clientId`.\n' +
    'Returns a `{ data, nextCursor }` page: `data` holds up to `limit` records (default 3, max 100 — ' +
    'raise it in one call when you can accept the payload), and a non-null `nextCursor` means more remain — ' +
    'pass it back as `startFrom` to page. Mode is auto-detected from the arguments present.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    const type = args.type as string;
    const field = args.field as string | undefined;
    const value = args.value as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const prefix = args.prefix as string | undefined;
    const startFrom = args.startFrom as string | undefined;
    try {
      let page: Page<Vectros.RecordResponse>;
      if (field) {
        // Lookup mode — validate exactly one lookup shape was supplied.
        const hasEquality = value !== undefined;
        const hasRange = from !== undefined || to !== undefined;
        const hasPrefix = prefix !== undefined;
        const modes = Number(hasEquality) + Number(hasRange) + Number(hasPrefix);
        if (modes === 0) {
          return toolError(
            'record_query',
            new Error(
              `lookup on field '${field}' needs one of: 'value' (exact), 'from'+'to' (range), or 'prefix'.`,
            ),
          );
        }
        if (modes > 1) {
          return toolError(
            'record_query',
            new Error("'value', 'from'/'to', and 'prefix' are mutually exclusive — provide exactly one."),
          );
        }
        if (hasRange && !(from !== undefined && to !== undefined)) {
          return toolError('record_query', new Error("range lookup requires both 'from' and 'to'."));
        }
        // POST-body lookup: sensitive-safe (value never in the URL), all modes in one path.
        page = await client.records.lookupRecordsByBody({
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
          { tool: 'record_query', mode: 'lookup', type, field, returned: pageItems(page).length },
          'record_query lookup ok',
        );
      } else {
        // List mode — filter by ownership + type.
        page = await client.records.listRecords({
          type,
          userId: args.userId as string | undefined,
          orgId: args.orgId as string | undefined,
          clientId: args.clientId as string | undefined,
          scope: args.scope as string | undefined,
          startFrom,
          limit,
        });
        log.debug(
          { tool: 'record_query', mode: 'list', type, limit, returned: pageItems(page).length },
          'record_query list ok',
        );
      }
      const records = pageItems(page);
      const nextCursor = page.nextCursor ?? null;
      return {
        content: [{ type: 'text', text: JSON.stringify({ data: records, nextCursor }, null, 2) }],
      };
    } catch (err) {
      log.warn({ tool: 'record_query', err: String(err) }, 'record_query failed');
      return toolError('record_query', err);
    }
  },
});

export default recordQuery;
