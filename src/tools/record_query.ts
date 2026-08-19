/**
 * record_query — read structured records, two modes (auto-detected by args):
 *
 *   field present → LOOKUP on a lookup-indexed field, one of:
 *                     • equality:  `value` — also valid on a composite field (see
 *                       below), matching just the first named field
 *                     • composite: `values` — ONLY on a field naming a lookup the
 *                       SCHEMA itself declared over several fields together (see
 *                       below); `field` names them comma-joined, e.g. "status,area"
 *                     • range:     `from` + `to` — NOT valid on a composite field
 *                     • prefix:    `prefix` — NOT valid on a composite field
 *   no field      → LIST by type (+ optional ownership filters)
 *
 * Composite lookups (SDK 0.38) are opt-in PER SCHEMA, not a general capability
 * this tool adds to any two fields: a schema's `lookupFields` entry must declare
 * `fieldNames: [...]` (in place of a single `fieldName`) naming those exact
 * fields, in that exact declared order, as ONE combined index — `list_schemas`
 * shows which lookups (if any) are declared this way for a given type. You
 * cannot combine two independently-declared single-field lookups by passing a
 * comma-joined `field` — that only works against a lookup the schema itself
 * declared as composite. Query a real one with `field` naming those fields
 * comma-joined and EITHER `values` (one value per field, in the SAME order the
 * schema declares them) OR a single `value` (exactly a one-element `values` —
 * matches the first field, grouping by the rest). Supplying FEWER values than
 * the lookup declares is allowed — it returns records GROUPED by the fields
 * left unspecified, with `order` sorting *within* each group, not across them;
 * `sortFrom`/`sortTo` need every value to give a single overall window. A
 * composite field is exact-match only — `from`/`to`/`prefix` have no meaning
 * over several fields at once and are rejected locally.
 * Record lookups ONLY — document/user/entity lookups match a single field and
 * were not extended (verified against the generated SDK types, not the
 * changelog prose: `DocumentLookupRequest`/`IdentityLookupRequest` are
 * byte-identical to 0.37.0).
 *
 * Lookups route through `lookupRecordsByBody` (POST /v1/records/lookup), NOT the
 * GET variant: the POST body supports equality/composite/range/prefix uniformly,
 * is the REQUIRED path for SENSITIVE lookup fields (the GET variant 400s — the
 * value can't ride the URL query string), and never leaks values into
 * access/proxy logs. One path, no GET/POST branching, no sensitivity sniffing.
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
  // Lookup-mode args — provide `field` plus EXACTLY ONE of: value | values | from+to | prefix.
  field: z
    .string()
    .optional()
    .describe(
      'Lookup mode: name of the lookup-indexed field to query by. `externalId` is always queryable — ' +
        'e.g. `{type:"control", field:"externalId", value:"ctrl-scoped-key"}` finds the record you created ' +
        'under that externalId. (record_get / record_update also accept externalId directly.) For a ' +
        "SCHEMA-declared composite lookup — check list_schemas' lookupFields for a fieldNames entry, not " +
        'any two fields you pick — give those field names comma-joined in the declared order (e.g. ' +
        '"status,area"). Use `values` to match on several of those fields at once, or `value` to match ' +
        'on just the FIRST field named (equivalent to a one-element `values`); range/prefix are not valid ' +
        'on a composite field.',
    ),
  value: z
    .string()
    .optional()
    .describe(
      "Lookup mode (equality): exact-match value for `field`. Also valid when `field` names a SCHEMA-declared " +
        'composite lookup — matches just the first named field, grouping by the rest (equivalent to `values` ' +
        'with one entry).',
    ),
  values: z
    .array(z.string())
    .min(1)
    .max(3)
    .optional()
    .describe(
      'Lookup mode (composite equality): only valid against a lookup the SCHEMA declares over several ' +
        'fields together (a fieldNames entry in list_schemas — you cannot combine two ordinary ' +
        'single-field lookups this way). One value per field, in the order the schema declares them ' +
        '(e.g. field="status,area", values=["open","billing"]). Mutually exclusive with `value`; a ' +
        'single-element array is exactly `value` written uniformly. Supplying FEWER values than the ' +
        "lookup declares is allowed — as long as they're a leading run of its fields — and returns " +
        'records grouped by the fields left unspecified; `order` then sorts within each group, not ' +
        'across them. Record lookups only (not documents/users/entities).',
    ),
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
  sortFrom: z
    .string()
    .optional()
    .describe(
      "Lookup mode (equality/composite only): inclusive lower bound on the lookup field's sort key, " +
        'narrowing a `value`/`values` match to a window instead of paging the whole match. Give the ' +
        "bound in the sort field's own units (epoch milliseconds for `createdAt`/`lastUpdated`). With " +
        '`values`, requires every value be supplied (no grouping) for one continuous ordering. Not ' +
        'valid with `from`/`to`/`prefix`.',
    ),
  sortTo: z
    .string()
    .optional()
    .describe('Lookup mode (equality/composite only): inclusive upper bound on the sort key; pairs with `sortFrom`.'),
  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe(
      'Lookup mode: sort direction by the looked-up field. `asc` (default) or `desc` — use `desc` with a range/' +
        'prefix lookup to get the most-recent / highest values first (e.g. latest-N). Ignored in list mode.',
    ),
  // List-mode args:
  userId: z.string().optional().describe('List mode: scope to records owned by this user.'),
  scope: z
    .string()
    .optional()
    .describe(
      'List mode: filter to records carrying this scope value, in `namespace:value` form ' +
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
    '  • Lookup on a lookup-indexed field: pass `field` plus exactly one of `value` (exact), `values` ' +
    '(exact, composite — one value per field; a single-element array is the same as `value`), `from`+`to` ' +
    '(range), or `prefix`. `values` with more than one entry, or a comma-joined `field`, ONLY works for a ' +
    "lookup the schema itself declared over several fields together — check list_schemas' lookupFields for " +
    'a fieldNames entry, then pass those field names comma-joined as `field`; `from`/`to`/`prefix` are not ' +
    'valid there. Works on sensitive fields too. Optionally narrow an exact match to a window with ' +
    '`sortFrom`/`sortTo`.\n' +
    '  • List by type: omit `field`; optionally filter by `userId` or `scope` (`namespace:value`).\n' +
    'Returns a `{ data, nextCursor }` page: `data` holds up to `limit` records (default 3, max 100 — ' +
    'raise it in one call when you can accept the payload), and a non-null `nextCursor` means more remain — ' +
    'pass it back as `startFrom` to page. A composite lookup given fewer than its full field count ' +
    'returns records grouped by the unspecified fields, ordered within each group. Mode is auto-detected ' +
    'from the arguments present.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    const type = args.type as string;
    const field = args.field as string | undefined;
    const value = args.value as string | undefined;
    const values = args.values as string[] | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const prefix = args.prefix as string | undefined;
    const sortFrom = args.sortFrom as string | undefined;
    const sortTo = args.sortTo as string | undefined;
    const startFrom = args.startFrom as string | undefined;
    // Every lookup-mode arg requires `field` — without it these are silently ignored
    // by list mode (`listRecords` has no notion of them), not rejected, which would
    // hand an agent 3 arbitrary records while it believes it queried a lookup.
    if (
      !field &&
      (value !== undefined ||
        values !== undefined ||
        from !== undefined ||
        to !== undefined ||
        prefix !== undefined ||
        sortFrom !== undefined ||
        sortTo !== undefined)
    ) {
      return toolError(
        'record_query',
        new Error(
          "'value'/'values'/'from'/'to'/'prefix'/'sortFrom'/'sortTo' require 'field' — without it, list " +
            "mode runs and silently ignores them. Pass 'field' to run a lookup, or drop these to list by type.",
        ),
      );
    }
    try {
      let page: Page<Vectros.RecordResponse>;
      if (field) {
        // Lookup mode — validate exactly one lookup shape was supplied.
        const fieldNames = field.split(',').map((f) => f.trim()).filter(Boolean);
        // Forward the NORMALIZED (trimmed, re-joined) field, not the raw string. A
        // composite's declared identity on the backend is `fieldNames.join(',')` exactly
        // (RecordSchemaDB's COMPOSITE_SEP) — forwarding an unnormalized "status, area" (a
        // stray space) or "status,,area" would parse to the right leg count HERE but fail
        // `lookupFieldConfig` lookup on the backend, surfacing as a confusing
        // single-field-vs-N-values error instead of the real problem.
        const normalizedField = fieldNames.join(',');
        const isCompositeField = fieldNames.length > 1;
        const hasEquality = value !== undefined;
        const hasComposite = values !== undefined;
        const hasRange = from !== undefined || to !== undefined;
        const hasPrefix = prefix !== undefined;
        const modes = Number(hasEquality) + Number(hasComposite) + Number(hasRange) + Number(hasPrefix);
        if (modes === 0) {
          return toolError(
            'record_query',
            new Error(
              `lookup on field '${field}' needs one of: 'value' (exact), 'values' (composite exact), ` +
                "'from'+'to' (range), or 'prefix'.",
            ),
          );
        }
        if (modes > 1) {
          return toolError(
            'record_query',
            new Error(
              "'value', 'values', 'from'/'to', and 'prefix' are mutually exclusive — provide exactly one.",
            ),
          );
        }
        if (hasRange && !(from !== undefined && to !== undefined)) {
          return toolError('record_query', new Error("range lookup requires both 'from' and 'to'."));
        }
        // A composite (multi-field) lookup is exact-match only — the server resolves
        // `value`/`values` to the SAME tuple (a scalar `value` is exactly a one-element
        // `values`, i.e. a valid leading-run partial match), but has no notion of a
        // range/prefix window over several fields at once.
        if (isCompositeField && (hasRange || hasPrefix)) {
          return toolError(
            'record_query',
            new Error(
              `'field' names ${fieldNames.length} fields ('${normalizedField}') — a composite lookup is ` +
                "exact-match only ('value' or 'values'), not 'from'/'to'/'prefix'.",
            ),
          );
        }
        if (hasComposite && values!.length > fieldNames.length) {
          return toolError(
            'record_query',
            new Error(
              `'values' has ${values!.length} entries but 'field' names only ${fieldNames.length} field(s) ` +
                `('${normalizedField}') — supply at most one value per field, in order (fewer only as a leading run).`,
            ),
          );
        }
        if (sortFrom !== undefined || sortTo !== undefined) {
          if (!(hasEquality || hasComposite)) {
            return toolError(
              'record_query',
              new Error("'sortFrom'/'sortTo' narrow a 'value' or 'values' match only — not 'from'/'to'/'prefix'."),
            );
          }
          // A partial (grouped) composite match has no single continuous ordering —
          // sortFrom/sortTo need every field's value, per the API's own contract.
          if (hasComposite && values!.length < fieldNames.length) {
            return toolError(
              'record_query',
              new Error(
                "'sortFrom'/'sortTo' with 'values' requires a value for every field named in 'field' " +
                  `(got ${values!.length} of ${fieldNames.length}) — a partial/grouped match has no single ` +
                  'continuous ordering to window.',
              ),
            );
          }
        }
        // POST-body lookup: sensitive-safe (value never in the URL), all modes in one path.
        // Forward `normalizedField`, not the raw `field` — see the comment above.
        page = await client.records.lookupRecordsByBody({
          type,
          field: normalizedField,
          value,
          values,
          from,
          to,
          prefix,
          sortFrom,
          sortTo,
          order: args.order as 'asc' | 'desc' | undefined,
          startFrom,
          limit,
        });
        log.debug(
          { tool: 'record_query', mode: 'lookup', type, field: normalizedField, returned: pageItems(page).length },
          'record_query lookup ok',
        );
      } else {
        // List mode — filter by ownership + type.
        page = await client.records.listRecords({
          type,
          userId: args.userId as string | undefined,
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
