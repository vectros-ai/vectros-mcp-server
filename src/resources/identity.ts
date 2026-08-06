/**
 * identity resource at `vectros://identity`.
 *
 * Parallel to the `current_identity` tool — same data, different
 * access pattern. Lets the MCP client passively know the
 * credential's tenant + principal scope without an explicit tool
 * call, useful for ambient "you're authed as X" UX hints.
 *
 * Delegates to the shared `resolveIdentity` helper so the tool +
 * resource stay in lockstep on the graceful-degradation contract.
 */
import type { ResourceFactory } from './types.js';
import { resolveIdentity } from '../identity.js';

const identityResource: ResourceFactory = ({ log, apiKey, environment }) => ({
  name: 'identity',
  uri: 'vectros://identity',
  title: 'Current identity (tenant + principal scope)',
  description:
    'The tenant + principal scope the MCP server is authenticated as. Returns the same payload as the ' +
    '`current_identity` tool: status, tenantId, environment, principalType, principalKeyId, principalLabel, ' +
    '(for scoped credentials) allowedActions + dataScope ({ userId, scopes[] }), plus mcpServerVersion and ' +
    'sdkVersion (this build\'s own version and the bundled @vectros-ai/sdk version). The /v1/ping backing ' +
    'call ships the extended shape today; the version fields are always client-derived.',
  mimeType: 'application/json',
  read: async (): Promise<string> => {
    const identity = await resolveIdentity({ log, apiKey, environment });
    return JSON.stringify(identity, null, 2);
  },
});

export default identityResource;
