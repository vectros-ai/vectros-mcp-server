/**
 * current_identity — wraps `/v1/ping` for "who am I authed as?"
 * surface.
 *
 * Thin wrapper over `resolveIdentity` from `../identity.js` — that
 * helper is also used by the `identity` resource so both surfaces
 * stay in lockstep. See the helper header for the
 * graceful-degradation contract details.
 *
 * Design contract (from the design doc § Identity &
 * exploration → current_identity + § "Backend deliverables surfaced
 * by MCP v0.2"):
 *
 * Response shape (the extended /v1/ping ships this in full today):
 * status, tenantId, environment, principalType, principalKeyId,
 * principalLabel?, allowedActions?, dataScope? ({ userId, scopes[] }),
 * tokenExpiresAt?.
 *
 * The resolver still merges over a client-side derived shape (status +
 * environment + principalType) so the no-fetch path — a test mock or a
 * programmatic embedder that omits apiKey/environment — degrades cleanly
 * rather than throwing; see resolveIdentity's contract.
 *
 * `mcpServerVersion` + `sdkVersion` are always client-derived — see
 * build-info.ts — never fetched from the backend, which has no way to know
 * what a given MCP server binary shipped with. The server-side `apiVersion`
 * leg (the deployed API build id) is a separate, backend-reported concept
 * and does not ship here — a backend change, tracked separately from this
 * package's own version reporting (which already ships).
 *
 * API 0.40.0 note: a scope clause can now also carry `granted_capabilities`
 * (`member-lifecycle` / `forensic-read` / `context-directory-read` /
 * `delegate-mint`, joined by `delegate-principal-stamp` in 0.42.0) — a THIRD
 * reach dimension alongside `allowedActions` and `dataScope`. `/v1/ping` does
 * not report it as of this SDK pin, so it is
 * absent here too (nothing to merge through) — `allowedActions` + `dataScope`
 * is not the complete picture for a credential that holds one. Once the
 * backend adds it to `PingResponse`, the `[key: string]: unknown` pass-through
 * in `IdentityShape` picks it up with no MCP server change.
 */
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { resolveIdentity } from '../identity.js';

const inputSchema = {
  // No args — current_identity describes the current credential.
};

const currentIdentity: ToolFactory = ({ log, apiKey, environment }) => ({
  name: 'current_identity',
  title: 'Current identity (tenant + principal scope)',
  description:
    "Describe the credential the MCP server is operating under. Returns tenantId, environment " +
    "(staging|production), principalType (root_key|scoped_key|token), principalKeyId, principalLabel, " +
    "and (for scoped credentials) allowedActions plus dataScope — the credential's verb+ownership reach " +
    "as { userId, scopes[] }, where each scope is a `namespace:value` string (e.g. \"org:<uuid>\"). Note: " +
    "this does not yet include granted_capabilities (member-lifecycle / forensic-read / " +
    "context-directory-read / delegate-mint, as of API 0.40.0, joined by delegate-principal-stamp " +
    "in 0.42.0) — a separate reach dimension a scope clause can carry that " +
    "/v1/ping does not report yet, so allowedActions+dataScope may understate a " +
    "credential's true reach. Also reports mcpServerVersion (this server's own package version) and " +
    "sdkVersion (the bundled @vectros-ai/sdk version) so a caller can tell what build it's talking to. " +
    "Use this when the user asks 'what can you do here?', 'what tenant am I in?', or 'what version is " +
    "this?'. Calls GET /v1/ping under the hood.",
  inputSchema,
  handler: async (): Promise<ToolResult> => {
    try {
      const identity = await resolveIdentity({ log, apiKey, environment });
      return {
        content: [{ type: 'text', text: JSON.stringify(identity, null, 2) }],
      };
    } catch (err) {
      log.warn({ tool: 'current_identity', err: String(err) }, 'current_identity failed');
      return toolError('current_identity', err);
    }
  },
});

export default currentIdentity;
