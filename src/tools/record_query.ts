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
 * MCP-specific limits (smaller than the API defaults): default 3 / max 10 —
 * records inject directly into the agent context window (token economy; see
 * the design doc § "Token economy"). The MCP `limit` is the cap:
 * one page returns at most `limit` records, so there is no hidden truncation
 * beyond the documented ceiling. Cursor pagination past the first page is
 * intentionally not exposed.
 *
 * SDK 0.23 returns the `{ data, nextCursor }` page envelope; we unwrap to the
 * bare `RecordResponse[]` (the v0.1/v0.2 agent contract) via `pageItems`.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { pageItems } from '../paging.js';

const MCP_DEFAULT_LIMIT = 3;
const MCP_MAX_LIMIT = 10;

const inputSchema = {
  type: z
    .string()
    .min(1, 'type (record type) is required')
    .describe('Record type / schema name (e.g. "patient", "clinical_note").'),
  // Lookup-mode args — provide `field` plus EXACTLY ONE of: value | from+to | prefix.
  field: z
    .string()
    .optional()
    .describe('Lookup mode: name of the lookup-indexed field to query by.'),
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
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(
      `Max records to return. MCP-specific cap of ${MCP_MAX_LIMIT} (vs API max of 100) ` +
        'to protect the agent context window. Default 3.',
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
    'Returns up to 10 records (default 3). Mode is auto-detected from the arguments present.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    const type = args.type as string;
    const field = args.field as string | undefined;
    const value = args.value as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const prefix = args.prefix as string | undefined;
    try {
      let records: Vectros.RecordResponse[];
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
        const page = await client.records.lookupRecordsByBody({
          type,
          field,
          value,
          from,
          to,
          prefix,
          order: args.order as 'asc' | 'desc' | undefined,
          limit,
        });
        records = pageItems(page);
        log.debug(
          { tool: 'record_query', mode: 'lookup', type, field, returned: records.length },
          'record_query lookup ok',
        );
      } else {
        // List mode — filter by ownership + type.
        const page = await client.records.listRecords({
          type,
          userId: args.userId as string | undefined,
          orgId: args.orgId as string | undefined,
          clientId: args.clientId as string | undefined,
          limit,
        });
        records = pageItems(page);
        log.debug(
          { tool: 'record_query', mode: 'list', type, limit, returned: records.length },
          'record_query list ok',
        );
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(records, null, 2) }],
      };
    } catch (err) {
      log.warn({ tool: 'record_query', err: String(err) }, 'record_query failed');
      return toolError('record_query', err);
    }
  },
});

export default recordQuery;
