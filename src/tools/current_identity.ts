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
    "and (for scoped credentials) allowedActions plus dataScope — the credential's reach as { userId, " +
    "scopes[] }, where each scope is a `namespace:value` string (e.g. \"org:<uuid>\"). Use this when the " +
    "user asks 'what can you do here?' or 'what tenant am I in?'. Calls GET /v1/ping under the hood.",
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
