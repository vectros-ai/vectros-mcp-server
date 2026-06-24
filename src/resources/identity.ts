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
    '`current_identity` tool: status, environment, principalType, principalKeyId, and (for scoped keys) ' +
    'allowedActions + dataScope. Until backend ships the extended /v1/ping response, returns a minimal ' +
    'derived shape; richer fields appear automatically as backend rolls out.',
  mimeType: 'application/json',
  read: async (): Promise<string> => {
    const identity = await resolveIdentity({ log, apiKey, environment });
    return JSON.stringify(identity, null, 2);
  },
});

export default identityResource;
