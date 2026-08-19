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
 * (`org`/`client` — reserved names, registered like any other — or one you
 * registered yourself).
 *
 * `contextId` (entity kinds only): a namespace registration is either
 * tenant-wide (its entities are visible everywhere, today's default for
 * `org`/`client` and any namespace registered without a context) or owned by
 * one app context (invisible outside it). A context-confined credential's own
 * context resolves automatically without this arg; pass it to name a specific
 * context when the credential is unconfined (a root key) and the namespace is
 * context-owned, or to be explicit. Rejected for `kind: "user"` (the user
 * surface is always tenant-wide) and for a namespace that turns out to be
 * tenant-wide (the API itself rejects that combination).
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
        '"org", "client" (reserved, registered like any other), or a namespace you registered.',
    ),
  externalId: z
    .string()
    .optional()
    .describe(
      'Resolve mode: your own stable identifier for the principal. Returns the single matching principal ' +
        '(with its Vectros UUID), or an empty array if none. The fastest path to the UUID the ownership ' +
        'filters need. Takes precedence if both this and a `field` lookup are supplied.',
    ),
  contextId: z
    .string()
    .optional()
    .describe(
      'Entity kinds only (not `user`, which is always tenant-wide): the app context to look up entities ' +
        'in, for a namespace registered as context-owned rather than tenant-wide. A context-confined ' +
        "credential's own context is used automatically without this; supply it to name a context " +
        'explicitly (required for an unconfined/root credential to reach a context-owned namespace). ' +
        'Rejected if the namespace turns out to be tenant-wide.',
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
    '`externalId` wins.) For an entity kind, `contextId` names a specific app context when the namespace ' +
    "is context-owned rather than tenant-wide; a context-confined credential's own context is used " +
    'automatically without it. Returns a `{ data, nextCursor }` page (default 10, max 100 — raise it in ' +
    'one call when you can accept the payload); a non-null `nextCursor` means more remain — pass it back ' +
    'as `startFrom`. Read-only — does not create or modify identities.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const kind = args.kind as string;
    const isUser = kind === 'user';
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    const externalId = args.externalId as string | undefined;
    const contextId = args.contextId as string | undefined;
    const type = args.type as string | undefined;
    const field = args.field as string | undefined;
    const value = args.value as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const prefix = args.prefix as string | undefined;
    const order = args.order as 'asc' | 'desc' | undefined;
    const startFrom = args.startFrom as string | undefined;

    // contextId only means anything for an entity namespace — the user surface is always
    // tenant-wide, so a caller-supplied contextId there is a caller error, not a silent no-op.
    if (contextId !== undefined && isUser) {
      return toolError(
        'lookup_principal',
        new Error("'contextId' does not apply to kind 'user' — the user surface is always tenant-wide."),
      );
    }
    // Spread conditionally rather than passing `contextId` unconditionally as a shorthand
    // property: `{ contextId }` with `contextId === undefined` still creates an OWN key whose
    // value is undefined, and whether the SDK's request serialization treats an explicit
    // `undefined` value the same as an absent key is not a guarantee we rely on — every existing
    // caller that never supplies `contextId` (i.e. every call before this param existed) must see
    // the key absent from the wire request, not present-with-value-undefined.
    const contextIdArg = contextId !== undefined ? { contextId } : {};

    try {
      let page: Page<unknown>;
      if (externalId !== undefined) {
        // Resolve mode — externalId → UUID. A user hits the fixed principal surface;
        // any other kind is an entity in the `kind` namespace. A resolve matches at
        // most one principal, so nextCursor is always null here.
        page = isUser
          ? await client.identity.listUsers({ externalId, limit })
          : await client.identity.listEntities({ namespace: kind, ...contextIdArg, externalId, limit });
        log.debug({ tool: 'lookup_principal', mode: 'resolve', kind, contextId }, 'lookup_principal resolve ok');
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
          : await client.identity.lookupEntities({ namespace: kind, ...contextIdArg, body: req });
        log.debug({ tool: 'lookup_principal', mode: 'lookup', kind, type, field, contextId }, 'lookup_principal lookup ok');
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
      log.warn({ tool: 'lookup_principal', kind, contextId, err: String(err) }, 'lookup_principal failed');
      return toolError('lookup_principal', err);
    }
  },
});

export default lookupPrincipal;
