# @vectros-ai/mcp-server

[![npm](https://img.shields.io/npm/v/@vectros-ai/mcp-server)](https://www.npmjs.com/package/@vectros-ai/mcp-server)
[![license](https://img.shields.io/npm/l/@vectros-ai/mcp-server)](https://www.apache.org/licenses/LICENSE-2.0)

A [Model Context Protocol](https://modelcontextprotocol.io) server
that exposes Vectros — hybrid search, structured records, documents,
and in-perimeter RAG / document Q&A — to MCP-aware agents (Claude
Desktop, Cursor, Code, Cline, Continue, VS Code, hosted agent
platforms).

```
npx -y @vectros-ai/mcp-server
```

Your agent can search your indexed corpus, query structured records,
ingest documents, and ask questions grounded against documents — all
without leaving the BAA boundary.

## Quick start — one command

The fastest way to set up is the [`@vectros-ai/cli`](https://www.npmjs.com/package/@vectros-ai/cli)
`bootstrap` command. It mints a **least-privilege scoped key** (`ssk_*`)
bound to a narrowed AccessProfile, optionally scaffolds a use-case data
model, and safe-merges the `vectros` server into your MCP client config —
no root key, and no hand-editing JSON:

```bash
npx -y @vectros-ai/cli bootstrap
```

You pick what to set up (a blank read-only credential, or a **blueprint**
like task tracking) and sign in once with a token from the
developer portal. The command then:

- mints a scoped `ssk_*` for **this machine** (independently rotatable),
- creates the matching AccessProfile — **data-plane only**; the command
  refuses to provision control-plane scope (keys / profiles / billing / …),
- backs up and merges the entry into `claude_desktop_config.json` (Claude
  Desktop, Cursor, Cline). For **Claude Code**, add `--client code`: it merges
  the project `.mcp.json` and prints the equivalent `claude mcp add` command.

Restart your MCP client and you're done. It's idempotent (re-run any time);
`--rotate` replaces this machine's key.

For scripted / agent use, set the sign-in token in the environment and skip
the prompts:

```bash
VECTROS_BOOTSTRAP_TOKEN=… npx -y @vectros-ai/cli bootstrap \
  --blueprint task-management --yes
```

Prefer to wire it up by hand? See **Configure manually** below.

## Configure manually (Claude Desktop or any MCP client)

```json
{
  "mcpServers": {
    "vectros": {
      "command": "npx",
      "args": ["-y", "@vectros-ai/mcp-server"],
      "env": {
        "VECTROS_API_KEY": "ssk_live_..."
      }
    }
  }
}
```

Restart Claude Desktop. The agent now sees the Vectros tools and
two resources as callable surfaces.

## Configure manually (Claude Code)

Claude Code reads a project-scoped `.mcp.json` with the same shape — drop this
at your project root (commit it to share the server with the repo):

```json
{
  "mcpServers": {
    "vectros": {
      "command": "npx",
      "args": ["-y", "@vectros-ai/mcp-server"],
      "env": {
        "VECTROS_API_KEY": "ssk_live_..."
      }
    }
  }
}
```

Or let Claude Code's CLI write it for you:

```bash
claude mcp add vectros -e VECTROS_API_KEY=ssk_live_... -- npx -y @vectros-ai/mcp-server
```

Add `-e VECTROS_API_BASE_URL=https://api.staging.vectros.ai` for a non-production
environment. Reopen the project in Claude Code and the Vectros tools are
available.

## Tools (21 tools)

**Search & RAG**

| Tool | What it does |
|---|---|
| `hybrid_search` | Hybrid BM25 + dense search across the tenant's indexed content (records + documents). Narrow by ownership, folder, type, metadata filters, a created date window, and keyword-precision (`textMode`) / relevance floors. Returns the indexed projection of each hit. |
| `rag_ask` | Ask a question grounded against the indexed corpus. Scope retrieval (ownership / folder / type / metadata filters / date window) and steer generation (`instructions` / `temperature`). Streaming generation aggregated; progress notifications keep the call alive for the generation window. |
| `document_ask` | Ask a question grounded against a single document. Same aggregation + progress-notification shape as `rag_ask`. |

**Records** (structured, schema-validated data)

| Tool | What it does |
|---|---|
| `list_schemas` | List the record-schema catalog the credential can see (filter by `surface` or resolve one by `recordType`). Makes `record_query` / `record_create` discoverable. |
| `record_query` | Query records by lookup field (equality / range / prefix, with `asc`/`desc` ordering) or list mode (filter by ownership + type). |
| `record_get` | Fetch one record by id, including its full payload (large payloads truncated to protect the agent context window). |
| `record_create` | Create a record of a given type; idempotent by `externalId`; optional per-record `indexMode`. |
| `record_update` | Patch a record's payload (deep-merged; `null` deletes a key); optimistic concurrency via `expectedVersion`. |
| `record_delete` | Permanently delete a record by id (leaves a tombstone). |

**Documents** (text/file content, indexed for search + Q&A)

| Tool | What it does |
|---|---|
| `document_ingest` | Create a document — inline text body OR local file upload (file mode is stdio-transport only). Idempotent by `externalId`; optional `schemaId` + `payload` for a typed, lookup-queryable document. |
| `document_query` | Query documents by lookup field (equality / range / prefix, with `asc`/`desc` ordering) or list mode (filter by ownership + type). |
| `document_get` | Fetch a document by id (metadata; optional text truncated at ~8K tokens; optional presigned `downloadUrl` for file-backed documents). |
| `document_update` | Patch a document's metadata / typed payload (deep-merged); optimistic concurrency via `expectedVersion`. |
| `document_delete` | Permanently delete a document by id (removes it and its indexed content). |

**Folders** (group records + documents)

| Tool | What it does |
|---|---|
| `folder_query` | Get a folder by id, or list folders (a parent's children for tree navigation, or a flat tenant list; paginated via `nextCursor`). |
| `folder_create` | Create a folder. |
| `folder_update` | Update a folder's name / description / ownership (merge-patch; optimistic concurrency via `expectedVersion`; folders cannot be re-parented). |
| `folder_delete` | Delete a folder. |

**Identity & history**

| Tool | What it does |
|---|---|
| `current_identity` | Describe the credential: tenantId, environment, principalType, and (where surfaced) allowedActions + dataScope. |
| `lookup_principal` | Resolve a user / org / client by your own `externalId` (→ its Vectros UUID, for the ownership filters) or by a schema lookup field. Read-only. |
| `version_history` | Read the audit/version trail (CREATE/UPDATE/DELETE, with actor + diff) for one record or document. Read-only. |

All 21 tools wrap published Vectros HTTP API endpoints. JSON
responses are what the agent sees as tool output. Per-call cost
surfaces via the `usage` field on inference responses.

### Opting into a subset

Pass `VECTROS_MCP_TOOLS=hybrid_search,rag_ask` to register only those
two — useful for giving an agent read-only search access without
exposing ingestion or inference costs to the credential. Unknown tool
names fail fast at startup.

## Resources

Two read-only resources for ambient context (no tool call required):

| URI | What it returns |
|---|---|
| `vectros://schemas` | Same payload as `list_schemas`. Lets the agent preload schemas into context for ambient discovery. |
| `vectros://identity` | Same payload as `current_identity`. Lets the agent self-describe without spending a tool call. |

## Recommended credential

Use a **scoped permanent API key** (`ssk_*`), not a root key (`sk_*`).

A scoped key is bound to a narrowed `AccessProfile` — e.g. read-only
across one `orgId`. If your MCP install is compromised, the blast
radius is whatever the profile allows, not the whole tenant. The
server emits a `warn` log line on startup when you pass a wildcard
`sk_*` for exactly this reason.

**The easiest way to get one is `npx -y @vectros-ai/cli bootstrap` (above)**
— it mints a least-privilege `ssk_*` and an AccessProfile for you, no root
key required. To do it by hand instead: mint a scoped key from the developer
portal under **Keys → Create scoped key**, bind it to an AccessProfile
titled `mcp-read-all` or `mcp-read-scoped`, and drop the resulting
`ssk_live_...` into the config above.

See the Vectros developer documentation on scoped tokens ("Recommended
AccessProfile for MCP") for least-privilege credential setup — the
`vectros bootstrap` flow provisions a scoped `ssk_*` key and its AccessProfile
in one command.

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `VECTROS_API_KEY` | **yes** | — | Vectros API key. Accepts `sk_*` / `ssk_*` / `st_*`; `ssk_*` recommended. |
| `VECTROS_API_BASE_URL` | no | `https://api.vectros.ai` | Override for staging or other envs. Validated: must be `https://` (or `http://` to localhost) and an official `*.vectros.ai` host. |
| `VECTROS_ALLOW_INSECURE_BASE_URL` | no | — | Set `1` to bypass the base-URL allow-list (e.g. a trusted local proxy). **Not recommended** — sends your key to an unvalidated host; logs a warning. |
| `VECTROS_MCP_INGEST_ROOT` | no | process cwd | Directory `document_ingest`'s `filePath` mode is jailed to. Paths escaping it (traversal/absolute/symlink) or matching a sensitive pattern are rejected. |
| `VECTROS_MCP_TOOLS` | no | (all tools) | Comma-separated tool names (e.g. `hybrid_search,rag_ask`). |
| `VECTROS_MCP_DEBUG` | no | — | Set `1` for verbose stderr logs. |
| `VECTROS_MCP_SKIP_PING_VALIDATION` | no | — | Set `1` to disable the startup `/v1/ping` check. |
| `VECTROS_MCP_HTTP_PORT` | HTTP only | `8765` | Port for HTTP transport. |
| `VECTROS_MCP_HTTP_HOST` | HTTP only | `127.0.0.1` | Bind address. Use `0.0.0.0` for all interfaces (then set a bearer token). |
| `VECTROS_MCP_HTTP_BEARER_TOKEN` | HTTP only | — | Client→server bearer token. **Strongly recommended** beyond localhost; **required** for a non-loopback bind. |
| `VECTROS_MCP_HTTP_ALLOWED_HOSTS` | HTTP only | — | Comma-separated extra `Host` values to allow (DNS-rebinding protection). Set to the public hostname(s) behind a reverse proxy. |
| `VECTROS_MCP_HTTP_ALLOWED_ORIGINS` | HTTP only | — | Comma-separated extra `Origin` values to allow. |
| `VECTROS_MCP_HTTP_ALLOW_INSECURE` | HTTP only | — | Set `1` to permit a non-loopback bind without a bearer token. **Not recommended.** |

## Startup credential validation

Before the first tool call, the server runs a `GET /v1/ping` check
against your credential. Bad keys fail at startup with a clear
error instead of opaquely 401'ing mid-conversation. Set
`VECTROS_MCP_SKIP_PING_VALIDATION=1` to disable.

## HTTP transport

For hosted-MCP scenarios — running the server behind a network
boundary, sharing it across multiple agent instances, deploying as
a sidecar — the package also ships an HTTP binary:

```bash
VECTROS_API_KEY=ssk_live_... \
VECTROS_MCP_HTTP_PORT=8765 \
VECTROS_MCP_HTTP_BEARER_TOKEN=$(openssl rand -hex 32) \
  npx -y @vectros-ai/mcp-server vectros-mcp-server-http
```

The server listens on `http://127.0.0.1:8765/mcp` by default. The
bearer token is optional but **strongly recommended for any
deployment beyond localhost** — without it, anyone who can reach the
port can call Vectros with your credentials.

Health probe lives at `GET /healthz` (always unauthenticated, k8s
readiness-friendly).

Current limitation: the server uses one upstream credential per process
(the env `VECTROS_API_KEY`). Per-request credential override via the
incoming Authorization header is a planned enhancement. For now, deploy one
server per credential boundary you want.

## Programmatic use (advanced)

Most consumers use the CLI shape above. If you need to embed the
server in your own Node process:

```ts
import { VectrosMCPServer, createStdioTransport } from '@vectros-ai/mcp-server';

const server = new VectrosMCPServer({
  apiKey: process.env.VECTROS_API_KEY!,
  tools: ['hybrid_search', 'rag_ask'],
  resources: ['schemas'],     // opt-in resource filter; default = all
  validateOnStart: true,      // default — set false to skip startup ping
});
await server.connect(createStdioTransport());
```

## What this server doesn't do (yet)

- **No prompts capability** — `/rag` and `/ingest_pdf` slash-command
  templates land in a future release. (Provisioning — the `bootstrap` command — lives
  in the separate [`@vectros-ai/cli`](https://www.npmjs.com/package/@vectros-ai/cli)
  package, above.)
- **HTTP transport is single-tenant per process** — per-request
  credential override via incoming Authorization header is a v1.0+
  enhancement.
- **No Python implementation** — TS only. Python users can `npx`
  this server from any project.
- **`rag_ask` and `document_ask` are not natively streaming** —
  full answer aggregated before the tool returns. Progress
  notifications cover the latency. Native MCP-spec streaming lands
  when the spec stabilizes.

The server is on a pre-1.0 track toward a stable 1.0 release.

## Building from source

```sh
git clone https://github.com/vectros-ai/mcp-server
cd mcp-server
npm install
npm run build
npm test
```

`npm install` pulls `@vectros-ai/sdk` from the configured npm
registry.

`npm run build` runs `tsup` to produce the dual ESM/CJS output in
`dist/`. The SDK is bundled into the build (see
[`tsup.config.ts`](./tsup.config.ts)) — the published npm package is
self-contained and works without `.npmrc` config on the consumer's
machine.

## License

Apache-2.0. See the LICENSE file.
