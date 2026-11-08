/**
 * run_get — wraps `client.agents.getRun(...)` → `GET /v1/runs/{id}`.
 *
 * Reads one agent run: its status, whether it has ended (`terminal`), why it
 * ended, its tool calls (each tool's name and outcome, never its arguments or
 * result) and what it was charged. It never returns the run's answer text, which
 * is delivered only while the run streams (agent_run returns it).
 *
 * Use it after agent_run returns `terminal: false` (the stream ended before the
 * run did), to learn how the run ended. A run is visible to the credential that
 * started it and is kept for 30 days after it ends. Needs the `runs:r` scope.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  runId: z.string().min(1, 'runId must be non-empty').describe('The run id agent_run returned (`runId`).'),
};

const runGet: ToolFactory = ({ client, log }) => ({
  name: 'run_get',
  title: 'Get an agent run',
  description:
    'Read one agent run by id: `status` (`RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` or `EXPIRED`), `terminal` ' +
    '(whether it has ended; poll until true), `reason`, `errorCode`, `steps`, its `toolCalls` (each tool and how ' +
    'it ended, never its arguments or result) and `usage` (what it was charged, in milli-cents). It does not ' +
    'return the answer text: agent_run returns that. Use it when agent_run returned `terminal: false`. ' +
    'Needs the `runs:r` scope, which starting a run (`runs:c`) does not include: a credential with only ' +
    '`runs:c` gets `403` here, and learns how its runs end only from agent_run\'s own result.',
  inputSchema,
  // A pure read: polling a run does not change it.
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args): Promise<ToolResult> => {
    const runId = args.runId as string;
    try {
      // The credential's own app context: the one agent_run starts runs in.
      const run = await client.agents.getRun({ id: runId });
      log.debug({ tool: 'run_get', runId, status: run.status, terminal: run.terminal }, 'run_get ok');
      return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'run_get', runId, err: String(err) }, 'run_get failed');
      return toolError('run_get', err);
    }
  },
});

export default runGet;
