/**
 * Shared resource-definition shape — mirror of the tool factory
 * pattern in ../tools/types.ts.
 *
 * MCP resources are read-only data discoverable via resources/list +
 * resources/read JSON-RPC calls. Each resource has a stable URI,
 * a human-readable name + description, a MIME type, and a `read()`
 * function that returns its text content.
 */
import type { ZodRawShape } from 'zod';
import type { VectrosClient } from '@vectros-ai/sdk';
import type { Logger } from '../log.js';

/**
 * Names of all REGISTERED resources — the contract for what
 * `resources: [...]` filter accepts.
 *
 * MUST stay in lockstep with `ALL_RESOURCE_FACTORIES` in
 * `./index.ts` — every name here needs a factory there, and vice
 * versa. The server iterates this list at construction; an
 * unimplemented name throws.
 */
export const RESOURCE_NAMES = ['schemas', 'identity'] as const;
export type ResourceName = (typeof RESOURCE_NAMES)[number];

export interface ResourceDefinition {
  name: ResourceName;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  /** Returns the resource's text content (JSON-encoded data). */
  read: () => Promise<string>;
}

export interface ResourceFactoryContext {
  client: VectrosClient;
  log: Logger;
  /** API key — needed by `identity` resource for raw /v1/ping fetch. */
  apiKey?: string;
  /** API base URL — same rationale as `apiKey`. */
  environment?: string;
}

export type ResourceFactory = (ctx: ResourceFactoryContext) => ResourceDefinition;

/** Re-exports used by tests. */
export type { ZodRawShape };
