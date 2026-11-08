/**
 * agent_list — wraps `client.agents.listAgents(...)` → `GET /v1/agents`.
 *
 * Lists the stored agents an MCP client can run with `agent_run`. Each agent is
 * returned as a summary (`id`, `name`, `description`, `latestVersion`, `status`)
 * whatever the credential's scopes: a credential holding only `runs:c` is given
 * exactly these fields by the API, and one that also holds `agents:r` is given the
 * whole definition (system prompt, tools, limits), which this tool leaves out so
 * the result has one shape and stays small in the agent's context. Reading how an
 * agent is defined is an administrative task outside this tool.
 *
 * It lists the credential's own app context, the one agent_run runs in.
 *
 * Needs `runs:c` or `agents:r`; without either the API answers `403`, returned
 * as a tool error.
 *
 * Result limits + pagination (the enumeration-limits contract):
 *   • DEFAULT 10, MAX 100 (the API max). A page of summaries is small.
 *   • PAGINATION — `{ data, nextCursor }`; pass `nextCursor` back as `startFrom`.
 *   • A non-null `nextCursor` means more agents may remain. Never a silent cut.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const MCP_DEFAULT_LIMIT = 10;
const MCP_MAX_LIMIT = 100;

/** The fields every caller that may list agents can see. */
export interface AgentSummary {
  id?: string;
  name?: string;
  description?: string;
  latestVersion?: number;
  status?: string;
}

export function toAgentSummary(agent: Vectros.AgentResponse): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    latestVersion: agent.latestVersion,
    status: agent.status,
  };
}

// No `contextId`: a run always acts in the credential's own app context, so listing another
// context would return agents agent_run cannot run.
const inputSchema = {
  includeRetired: z
    .boolean()
    .optional()
    .describe('Also list retired and purged agents (neither can be run). Default false.'),
  startFrom: z
    .string()
    .optional()
    .describe('Pagination cursor: pass the `nextCursor` from the previous page to fetch the next.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_MAX_LIMIT)
    .optional()
    .describe(`Max agents per page. Default ${MCP_DEFAULT_LIMIT}, max ${MCP_MAX_LIMIT}.`),
};

const agentList: ToolFactory = ({ client, log }) => ({
  name: 'agent_list',
  title: 'List agents',
  description:
    'List the stored agents you can run with agent_run, newest first. Each is returned as its `id`, `name`, ' +
    '`description`, `latestVersion` and `status`; only an `ACTIVE` agent can be run. Retired and purged agents are ' +
    'left out unless `includeRetired` is true. Returns a `{ data, nextCursor }` page: a non-null `nextCursor` means more ' +
    'remain, pass it back as `startFrom`. Needs the `runs:c` or `agents:r` scope; running a listed agent needs ' +
    '`runs:c`, so a credential with only `agents:r` can list agents but not run them.',
  inputSchema,
  // A pure read: it lists definitions and changes nothing.
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args): Promise<ToolResult> => {
    const limit = (args.limit as number | undefined) ?? MCP_DEFAULT_LIMIT;
    try {
      const page = await client.agents.listAgents({
        includeRetired: args.includeRetired as boolean | undefined,
        startFrom: args.startFrom as string | undefined,
        limit,
      });
      const data = (page.data ?? []).map(toAgentSummary);
      const nextCursor = page.nextCursor ?? null;
      log.debug({ tool: 'agent_list', limit, returned: data.length }, 'agent_list ok');
      return { content: [{ type: 'text', text: JSON.stringify({ data, nextCursor }, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'agent_list', err: String(err) }, 'agent_list failed');
      return toolError('agent_list', err);
    }
  },
});

export default agentList;
