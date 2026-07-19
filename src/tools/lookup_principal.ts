/**
 * lookup_principal — resolve a user identity or a namespaced identity entity
 * (org / client / any namespace you registered), two modes (auto-detected by args):
 *
 *   externalId present → RESOLVE your own identifier to the Vectros UUID
 *                        (`listUsers`/`listEntities({externalId})`). Returns a
 *                        one-element array, or empty if no match.
 *   field present      → LOOKUP on a schema-declared lookup field, one of:
 *                          • equality: `value`
 *                          • range:    `from` + `to`
 *                          • prefix:   `prefix`
 *                        (`type` — the identity schema's record type — is
 *                        required here.) Routed through the POST-body lookup
 *                        (`lookupUsers`/`lookupEntities`), which is sensitive-safe
 *                        (the value never rides the URL query string).
 *
 * Orgs and clients are namespaces over a generic identity-entity model: `user`
 * is the fixed principal surface; every other `kind` is an entity namespace
 * (`org`/`client` — built in — or one you registered).
 *
 * Why this exists: the ownership filters on record_query / document_query /
 * hybrid_search / rag_ask take the Vectros-assigned UUID, but an agent usually
 * holds its OWN identifier (the partner's externalId). This tool bridges the
 * two — resolve once, then scope reads by the returned id.
 *
 * Read-only: requires the credential to allow the relevant read scope
 * (`users:r` for a user; `entities:r:<namespace>` for an entity). It never creates
 * or mutates identities — identity CRUD stays off the agent tool surface by design.
 *
 * Result limits + pagination (the enumeration-limits contract): default 10 / max 100 (the principals
 * API max — raise `limit` in one call when you can accept the payload). The result is the
 * `{ data, nextCursor }` envelope; a non-null `nextCursor` means more principals may remain
 * — pass it back as `startFrom` to page. Resolve mode returns at most one match, so its
 * cursor is always null.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { pageItems, type Page } from '../paging.js';

const MCP_DEFAULT_LIMIT = 10;
const MCP_MAX_LIMIT = 100;

const inputSchema = {
  kind: z
    .string()
    .describe(
      'Which principal to look up: "user" (the fixed principal surface), or an entity namespace — ' +
        '"org", "client" (built in), or a namespace you registered.',
    ),
  externalId: z
    .string()
    .optional()
    .describe(
      'Resolve mode: your own stable identifier for the principal. Returns the single matching principal ' +
        '(with its Vectros UUID), or an empty array if none. The fastest path to the UUID the ownership ' +
        'filters need. Takes precedence if both this and a `field` lookup are supplied.',
    ),
  // Lookup-mode args — provide `field` plus EXACTLY ONE of: value | from+to | prefix.
  type: z
    .string()
    .optional()
    .describe('Lookup mode: the identity schema\'s record type (e.g. "person_v1"). Required with `field`.'),
  field: z
    .string()
    .optional()
    .describe('Lookup mode: name of the schema-declared lookup field to query by (e.g. "email").'),
  value: z.string().optional().describe('Lookup mode (equality): exact-match value for `field`. Works on sensitive fields.'),
  from: z.string().optional().describe('Lookup mode (range): inclusive lower bound; requires `to`. Non-sensitive fields only.'),
  to: z.string().optional().describe('Lookup mode (range): inclusive upper bound; requires `from`.'),
  prefix: z
    .string()
    .optional()
    .describe('Lookup mode (prefix): match values starting with this. Range-enabled string fields only.'),
  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Lookup mode: sort direction by the looked-up field. `asc` (default) or `desc`.'),
  startFrom: z
    .string()
    .optional()
    .describe('Lookup mode: pagination cursor — pass the `nextCursor` from the previous page to fetch the next.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(
      `Max principals per page. Defaults to ${MCP_DEFAULT_LIMIT}; raise up to ${MCP_MAX_LIMIT} (the ` +
        'principals API max) in one call when you can accept the payload, or page with `startFrom`.',
    ),
};

const lookupPrincipal: ToolFactory = ({ client, log }) => ({
  name: 'lookup_principal',
  title: 'Look up a user identity or a namespaced identity entity',
  description:
    'Resolve a user, or an identity entity in a namespace (org/client/one you registered). Two modes:\n' +
    '  • Resolve by your own id: pass `externalId` → the matching principal incl. its Vectros UUID (the id the ' +
    'ownership filters on record_query / hybrid_search / rag_ask expect).\n' +
    '  • Lookup by a schema field: pass `type` and `field` plus exactly one of `value` (exact), `from`+`to` ' +
    '(range), or `prefix`. Sensitive-field-safe. (If both `externalId` and a `field` lookup are given, ' +
    '`externalId` wins.) Returns a `{ data, nextCursor }` page (default 10, max 100 — raise it in one call ' +
    'when you can accept the payload); a non-null `nextCursor` means more remain — pass it back as `startFrom`. ' +
    'Read-only — does not create or modify identities.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const kind = args.kind as string;
    const isUser = kind === 'user';
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    const externalId = args.externalId as string | undefined;
    const type = args.type as string | undefined;
    const field = args.field as string | undefined;
    const value = args.value as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const prefix = args.prefix as string | undefined;
    const order = args.order as 'asc' | 'desc' | undefined;
    const startFrom = args.startFrom as string | undefined;

    try {
      let page: Page<unknown>;
      if (externalId !== undefined) {
        // Resolve mode — externalId → UUID. A user hits the fixed principal surface;
        // any other kind is an entity in the `kind` namespace. A resolve matches at
        // most one principal, so nextCursor is always null here.
        page = isUser
          ? await client.identity.listUsers({ externalId, limit })
          : await client.identity.listEntities({ namespace: kind, externalId, limit });
        log.debug({ tool: 'lookup_principal', mode: 'resolve', kind }, 'lookup_principal resolve ok');
      } else if (field !== undefined) {
        // Lookup mode — validate exactly one lookup shape, then require `type`.
        const hasEquality = value !== undefined;
        const hasRange = from !== undefined || to !== undefined;
        const hasPrefix = prefix !== undefined;
        const modes = Number(hasEquality) + Number(hasRange) + Number(hasPrefix);
        if (modes === 0) {
          return toolError(
            'lookup_principal',
            new Error(`lookup on field '${field}' needs one of: 'value' (exact), 'from'+'to' (range), or 'prefix'.`),
          );
        }
        if (modes > 1) {
          return toolError(
            'lookup_principal',
            new Error("'value', 'from'/'to', and 'prefix' are mutually exclusive — provide exactly one."),
          );
        }
        if (hasRange && !(from !== undefined && to !== undefined)) {
          return toolError('lookup_principal', new Error("range lookup requires both 'from' and 'to'."));
        }
        if (type === undefined) {
          return toolError(
            'lookup_principal',
            new Error("lookup requires 'type' (the identity schema's record type) alongside 'field'."),
          );
        }
        // POST-body lookup: sensitive-safe (value never in the URL), all modes in one path.
        // A user takes the lookup request directly; an entity nests it under `body`
        // with the `kind` namespace on the envelope.
        const req = { type, field, value, from, to, prefix, order, startFrom, limit };
        page = isUser
          ? await client.identity.lookupUsers(req)
          : await client.identity.lookupEntities({ namespace: kind, body: req });
        log.debug({ tool: 'lookup_principal', mode: 'lookup', kind, type, field }, 'lookup_principal lookup ok');
      } else {
        return toolError(
          'lookup_principal',
          new Error("provide `externalId` (resolve) or `type`+`field`+a lookup mode (lookup)."),
        );
      }

      const principals = pageItems(page);
      const nextCursor = page.nextCursor ?? null;
      return { content: [{ type: 'text', text: JSON.stringify({ data: principals, nextCursor }, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'lookup_principal', kind, err: String(err) }, 'lookup_principal failed');
      return toolError('lookup_principal', err);
    }
  },
});

export default lookupPrincipal;
