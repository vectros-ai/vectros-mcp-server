/**
 * lookup_principal — resolve a user / org / client identity, two modes
 * (auto-detected by args):
 *
 *   externalId present → RESOLVE your own identifier to the Vectros UUID
 *                        (`list{Users,Orgs,Clients}({externalId})`). Returns a
 *                        one-element array, or empty if no match.
 *   field present      → LOOKUP on a schema-declared lookup field, one of:
 *                          • equality: `value`
 *                          • range:    `from` + `to`
 *                          • prefix:   `prefix`
 *                        (`type` — the identity schema's record type — is
 *                        required here.) Routed through the POST-body lookup
 *                        (`lookup{Users,Orgs,Clients}`), which is sensitive-safe
 *                        (the value never rides the URL query string).
 *
 * Why this exists: the ownership filters on record_query / document_query /
 * hybrid_search / rag_ask take the Vectros-assigned UUID, but an agent usually
 * holds its OWN identifier (the partner's externalId). This tool bridges the
 * two — resolve once, then scope reads by the returned id.
 *
 * Read-only: requires the credential to allow the relevant read scope
 * (`users:r` / `orgs:r` / `clients:r`). It never creates or mutates identities —
 * identity CRUD stays off the agent tool surface by design.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { pageItems, type Page } from '../paging.js';

const MCP_DEFAULT_LIMIT = 10;
const MCP_MAX_LIMIT = 50;

const inputSchema = {
  kind: z
    .enum(['user', 'org', 'client'])
    .describe('Which principal to look up: a user, an organization, or a client.'),
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
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(`Max principals to return. MCP cap of ${MCP_MAX_LIMIT} (vs API 100). Default ${MCP_DEFAULT_LIMIT}.`),
};

const lookupPrincipal: ToolFactory = ({ client, log }) => ({
  name: 'lookup_principal',
  title: 'Look up a user / org / client identity',
  description:
    'Resolve a user, org, or client identity. Two modes:\n' +
    '  • Resolve by your own id: pass `externalId` → the matching principal incl. its Vectros UUID (the id the ' +
    'ownership filters on record_query / hybrid_search / rag_ask expect).\n' +
    '  • Lookup by a schema field: pass `type` and `field` plus exactly one of `value` (exact), `from`+`to` ' +
    '(range), or `prefix`. Sensitive-field-safe. (If both `externalId` and a `field` lookup are given, ' +
    '`externalId` wins.) Returns up to 50 principals (default 10) as a bare array. ' +
    'Read-only — does not create or modify identities.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const kind = args.kind as 'user' | 'org' | 'client';
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    const externalId = args.externalId as string | undefined;
    const type = args.type as string | undefined;
    const field = args.field as string | undefined;
    const value = args.value as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const prefix = args.prefix as string | undefined;
    const order = args.order as 'asc' | 'desc' | undefined;

    try {
      let page: Page<unknown>;
      if (externalId !== undefined) {
        // Resolve mode — externalId → UUID. One SDK call per kind (the request
        // shapes differ per kind but all accept externalId + limit).
        if (kind === 'user') {
          page = await client.identity.listUsers({ externalId, limit });
        } else if (kind === 'org') {
          page = await client.identity.listOrgs({ externalId, limit });
        } else {
          page = await client.identity.listClients({ externalId, limit });
        }
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
        const req = { type, field, value, from, to, prefix, order, limit };
        if (kind === 'user') {
          page = await client.identity.lookupUsers(req);
        } else if (kind === 'org') {
          page = await client.identity.lookupOrgs(req);
        } else {
          page = await client.identity.lookupClients(req);
        }
        log.debug({ tool: 'lookup_principal', mode: 'lookup', kind, type, field }, 'lookup_principal lookup ok');
      } else {
        return toolError(
          'lookup_principal',
          new Error("provide `externalId` (resolve) or `type`+`field`+a lookup mode (lookup)."),
        );
      }

      const principals = pageItems(page);
      return { content: [{ type: 'text', text: JSON.stringify(principals, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'lookup_principal', kind, err: String(err) }, 'lookup_principal failed');
      return toolError('lookup_principal', err);
    }
  },
});

export default lookupPrincipal;
