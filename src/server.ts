/**
 * VectrosMCPServer — the public class. Composes:
 *   - API-key parse + warnings
 *   - Vectros SDK client construction
 *   - MCP Server with the v0.1 tool catalog registered
 *   - The `tools: [...]` opt-in filter (CodeBlock.js contract)
 *
 * Transport (stdio for v0.1) is connected separately via
 * `server.connect(transport)`. The CLI entry wires stdio.
 *
 * Public surface — see the design doc § "Configuration"
 * for the constructor-options shape.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { VectrosClient } from '@vectros-ai/sdk';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { parseApiKey, warnOnSuboptimalKey } from './auth.js';
import { BUILD_INFO } from './build-info.js';
import { createLogger, type Logger } from './log.js';
import { resolveIdentity } from './identity.js';
import { validateBaseUrl } from './base-url.js';
import { ALL_TOOL_FACTORIES, type ToolName, TOOL_NAMES } from './tools/index.js';
import type { ToolDefinition, ToolExtra, ToolResult } from './tools/types.js';
import { toolError } from './tools/errors.js';
import {
  ALL_RESOURCE_FACTORIES,
  type ResourceName,
  RESOURCE_NAMES,
} from './resources/index.js';
import type { ResourceDefinition } from './resources/types.js';
import { zodShapeToJsonSchema } from './zod-to-json-schema.js';

const DEFAULT_ENVIRONMENT = 'https://api.vectros.ai';

export interface VectrosMCPServerOptions {
  /** Vectros API key. REQUIRED. Recommended shape: ssk_live_... or ssk_test_.... */
  apiKey: string;
  /** Opt-in tool filter. Default: all v0.1 tools enabled. */
  tools?: ToolName[];
  /**
   * Opt-in resource filter (v0.2+). Default: all resources enabled.
   * Pass `[]` to register zero resources (server advertises no
   * resources capability via tools/list).
   */
  resources?: ResourceName[];
  /**
   * Vectros API base URL. Default: https://api.vectros.ai. The SDK
   * calls this `environment`; we keep the docs-aligned name on our
   * surface to match the design doc.
   */
  apiBaseUrl?: string;
  /** Provide a logger to capture server output. Default: pino → stderr. */
  logger?: Logger;
  /**
   * Which transport this server will be wired up with. Optional; only
   * affects tool behavior that depends on partner-local-fs access
   * (currently `document_ingest`'s filePath mode is stdio-only). The
   * CLI entry points set this — `cli.ts` passes 'stdio', the v0.2
   * `cli-http.ts` passes 'http'. Programmatic embedders default to
   * 'stdio' semantics if omitted.
   */
  transport?: 'stdio' | 'http';
  /**
   * If true (default in v0.2), perform a GET /v1/ping check during
   * `connect()` to fail-fast on bad credentials BEFORE the MCP
   * client sends its first tool call. The default is safe — partners
   * who don't want the network roundtrip on startup can set false,
   * but the trade-off is "credential failures surface mid-tool-call
   * rather than at startup."
   *
   * The CLI honors `VECTROS_MCP_SKIP_PING_VALIDATION=1` env var as
   * an explicit opt-out (sets this to false). Useful in CI / dev
   * environments where the API isn't reachable.
   */
  validateOnStart?: boolean;
  /**
   * Filesystem root that `document_ingest`'s stdio `filePath` mode is
   * jailed to. Overrides `VECTROS_MCP_INGEST_ROOT`; when both are
   * absent the tool defaults to `process.cwd()`.
   */
  ingestRoot?: string;
}

export class VectrosMCPServer {
  private readonly server: Server;
  private readonly log: Logger;
  private readonly tools: ToolDefinition[];
  private readonly resources: ResourceDefinition[];
  private readonly apiKey: string;
  private readonly environment: string;
  private readonly validateOnStart: boolean;

  constructor(opts: VectrosMCPServerOptions) {
    this.log = opts.logger ?? createLogger();

    // Auth — parse + warn (fail-fast on malformed).
    const keyInfo = parseApiKey(opts.apiKey);
    warnOnSuboptimalKey(keyInfo, this.log);
    this.log.info(
      { keyPrefix: keyInfo.prefix, keyEnv: keyInfo.env },
      'authenticated against Vectros',
    );

    // SDK client. Validate the base URL here too (R1 F-06a) — the CLI entry
    // points validate before construction, but a programmatic embedder reaches
    // this directly; an unvalidated host would exfiltrate the API key via
    // /v1/ping. Throws InvalidBaseUrlError on a non-Vectros / insecure host.
    const environment = opts.apiBaseUrl ?? DEFAULT_ENVIRONMENT;
    validateBaseUrl(environment, { warn: (m) => this.log.warn(m) });
    const client = new VectrosClient({ token: opts.apiKey, environment });

    // Stash for connect-time validation.
    this.apiKey = opts.apiKey;
    this.environment = environment;
    this.validateOnStart = opts.validateOnStart ?? true;

    // Build the enabled tool set.
    const requested = opts.tools ?? [...TOOL_NAMES];
    const invalid = requested.filter((n) => !TOOL_NAMES.includes(n as ToolName));
    if (invalid.length > 0) {
      throw new Error(
        `Unknown tool names in opts.tools: ${invalid.join(', ')}. ` +
          `Valid names: ${TOOL_NAMES.join(', ')}.`,
      );
    }
    this.tools = requested.map((name) => {
      const factory = ALL_TOOL_FACTORIES[name];
      return factory({
        client,
        log: this.log,
        apiKey: opts.apiKey,
        environment,
        transport: opts.transport,
        ingestRoot: opts.ingestRoot,
      });
    });
    this.log.info(
      { tools: this.tools.map((t) => t.name) },
      `${this.tools.length} tool(s) enabled`,
    );

    // Build the enabled resource set (v0.2+).
    const requestedResources = opts.resources ?? [...RESOURCE_NAMES];
    const invalidResources = requestedResources.filter(
      (n) => !RESOURCE_NAMES.includes(n as ResourceName),
    );
    if (invalidResources.length > 0) {
      throw new Error(
        `Unknown resource names in opts.resources: ${invalidResources.join(', ')}. ` +
          `Valid names: ${RESOURCE_NAMES.join(', ')}.`,
      );
    }
    this.resources = requestedResources.map((name) => {
      const factory = ALL_RESOURCE_FACTORIES[name];
      return factory({
        client,
        log: this.log,
        apiKey: opts.apiKey,
        environment,
      });
    });
    this.log.info(
      { resources: this.resources.map((r) => r.name) },
      `${this.resources.length} resource(s) enabled`,
    );

    // MCP Server instance — advertise both tools + resources
    // capabilities (resources only if any are registered).
    const capabilities: { tools: object; resources?: object } = { tools: {} };
    if (this.resources.length > 0) {
      capabilities.resources = {};
    }
    this.server = new Server(
      { name: '@vectros-ai/mcp-server', version: BUILD_INFO.mcpServer },
      { capabilities },
    );

    this.wireHandlers();
  }

  /**
   * Wire `tools/list` and `tools/call` JSON-RPC handlers on the
   * underlying MCP Server. Each tool's handler is wrapped to convert
   * thrown errors into `isError: true` tool results.
   */
  private wireHandlers(): void {
    // SDK type-union disambiguation note: setRequestHandler's return
    // type is a ServerResult union that includes a Managed-Agents
    // `{task: {...}}` variant. Our handlers return CallToolResult-
    // shaped objects (`{content, isError?}`) — assignable at runtime
    // but TypeScript's strict-distributive union check can't pick
    // the right variant. Cast the return to `unknown` to suppress.
    this.server.setRequestHandler(ListToolsRequestSchema, async () =>
      ({
        tools: this.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: zodShapeToJsonSchema(t.inputSchema),
        })),
      }) as unknown as never,
    );

    this.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const tool = this.tools.find((t) => t.name === req.params.name);
      let result: ToolResult;
      if (!tool) {
        result = toolError(req.params.name ?? 'unknown', new Error('No such tool.'));
      } else {
        // Validate args via zod.
        const parsed = z.object(tool.inputSchema).safeParse(req.params.arguments ?? {});
        if (!parsed.success) {
          result = toolError(tool.name, new Error(`Invalid arguments: ${parsed.error.message}`));
        } else {
          try {
            // The MCP SDK's `extra` object exposes sendNotification +
            // _meta.progressToken. Cast through unknown — the SDK's
            // generated types over-constrain the notification shape.
            result = await tool.handler(
              parsed.data as Record<string, unknown>,
              extra as unknown as ToolExtra,
            );
          } catch (err) {
            // Defensive — tool handlers should already catch internally.
            result = toolError(tool.name, err);
          }
        }
      }
      // See header comment on the ListToolsRequestSchema handler for
      // why this cast is needed.
      return result as unknown as never;
    });

    // Resources — only wire if any are registered. Skipping the
    // handler-wire when resources=[] means the MCP server doesn't
    // accept resources/list calls at all, matching the "advertise
    // no resources capability" behavior in the constructor.
    if (this.resources.length > 0) {
      this.server.setRequestHandler(ListResourcesRequestSchema, async () =>
        ({
          resources: this.resources.map((r) => ({
            uri: r.uri,
            name: r.name,
            title: r.title,
            description: r.description,
            mimeType: r.mimeType,
          })),
        }) as unknown as never,
      );

      this.server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const uri = req.params.uri;
        const resource = this.resources.find((r) => r.uri === uri);
        if (!resource) {
          // MCP spec: unknown URI → throw an error (the SDK converts
          // to a JSON-RPC error response). No "isError" flag like
          // tools — resources use protocol-level errors.
          throw new Error(`No such resource URI: ${uri}`);
        }
        try {
          const text = await resource.read();
          return {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType,
                text,
              },
            ],
          } as unknown as never;
        } catch (err) {
          this.log.warn(
            { resource: resource.name, uri, err: String(err) },
            'resource read failed',
          );
          throw err;
        }
      });
    }
  }

  /**
   * Connect the underlying MCP Server to a transport (stdio, HTTP,
   * etc.). Returns when the connection is established; the server
   * continues serving until the transport closes.
   *
   * If `validateOnStart` (default true) is enabled, performs a
   * GET /v1/ping check BEFORE wiring the transport. On failure,
   * throws — the partner's MCP client sees a startup error instead
   * of a confusing "tools work but the first call 401s" experience.
   */
  async connect(transport: Transport): Promise<void> {
    if (this.validateOnStart) {
      await this.validateCredentials();
    }
    await this.server.connect(transport);
    this.log.info({ transport: transport.constructor.name }, 'MCP server connected');
  }

  /**
   * GET /v1/ping with the configured credential. Throws on non-2xx.
   * Called by `connect()` if `validateOnStart` is true.
   *
   * Uses `resolveIdentity` so it stays in lockstep with the
   * graceful-degradation contract (works whether backend has shipped
   * the extended ping shape or not — we only care about the 2xx vs
   * non-2xx signal for validation).
   */
  private async validateCredentials(): Promise<void> {
    try {
      await resolveIdentity({
        log: this.log,
        apiKey: this.apiKey,
        environment: this.environment,
      });
      this.log.info(
        { url: `${this.environment.replace(/\/$/, '')}/v1/ping` },
        'startup ping validation ok',
      );
    } catch (err) {
      this.log.fatal(
        { err: err instanceof Error ? err.message : String(err) },
        'startup ping validation failed — check credential + base URL',
      );
      throw err;
    }
  }

  /** Close the underlying MCP Server. Idempotent. */
  async close(): Promise<void> {
    await this.server.close();
  }

  /**
   * Names of the tools registered on this server, in registration
   * order. Useful for tests + diagnostic logs. Read-only — the
   * registered set is fixed at construction time.
   */
  get registeredToolNames(): readonly ToolName[] {
    return this.tools.map((t) => t.name);
  }

  /**
   * Names of the resources registered on this server, in
   * registration order. Read-only.
   */
  get registeredResourceNames(): readonly ResourceName[] {
    return this.resources.map((r) => r.name);
  }
}

