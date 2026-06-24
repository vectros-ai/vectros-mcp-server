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
 * Target response shape: status, tenantId, environment,
 * principalType, principalKeyId, principalLabel?, allowedActions?,
 * dataScope?, tokenExpiresAt?.
 *
 * Until backend ships the extended /v1/ping response, returns a
 * minimal derived shape (status + environment + principalType).
 * Fields appear automatically as backend rolls out — no MCP server
 * version bump required.
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
    "(staging|production), principalType (root_key|scoped_key|token), principalKeyId, and (for scoped " +
    "keys) allowedActions + dataScope. Use this when the user asks 'what can you do here?' or 'what " +
    "tenant am I in?'. Calls GET /v1/ping under the hood. " +
    "Backend may still be rolling out the extended /v1/ping response shape — until then this tool " +
    "returns a minimal shape; richer fields appear automatically as backend ships.",
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
