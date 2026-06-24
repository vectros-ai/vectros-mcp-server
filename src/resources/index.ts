/**
 * Resource registry — the v0.2 catalog. Each resource is a factory
 * that the server instantiates with the SDK client + logger + (for
 * the identity resource) the API key + environment.
 *
 * Order here is the order resources appear in `resources/list`
 * responses to the MCP client.
 *
 * MUST stay in lockstep with `RESOURCE_NAMES` in `./types.ts` —
 * every name in the type union has a factory here.
 */
import type { ResourceFactory } from './types.js';
import schemasResource from './schemas.js';
import identityResource from './identity.js';

export const ALL_RESOURCE_FACTORIES: Record<string, ResourceFactory> = {
  schemas: schemasResource,
  identity: identityResource,
};

export {
  RESOURCE_NAMES,
  type ResourceName,
  type ResourceDefinition,
  type ResourceFactory,
} from './types.js';
