# @vectros-ai/mcp-server

[![npm](https://img.shields.io/npm/v/@vectros-ai/mcp-server)](https://www.npmjs.com/package/@vectros-ai/mcp-server)
[![license](https://img.shields.io/npm/l/@vectros-ai/mcp-server)](https://www.apache.org/licenses/LICENSE-2.0)

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=vectros&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB2ZWN0cm9zLWFpL21jcC1zZXJ2ZXIiXSwiZW52Ijp7IlZFQ1RST1NfQVBJX0tFWSI6IiJ9fQ%3D%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=vectros&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40vectros-ai%2Fmcp-server%22%5D%2C%22env%22%3A%7B%22VECTROS_API_KEY%22%3A%22%22%7D%7D)
[![Claude Desktop Extension](https://img.shields.io/badge/Claude_Desktop-Add_Extension-D97757)](https://github.com/vectros-ai/vectros-mcp-server/releases/latest/download/vectros.mcpb)

> One-click badges install the **server entry** in your client. You still supply
> a key — run `npx -y @vectros-ai/cli bootstrap` (recommended) or paste your
> `ssk_...`. See [Connect from your client](#connect-from-your-client) and the
> [honest caveats](#honest-caveats).

A [Model Context Protocol](https://modelcontextprotocol.io) server for
**Vectros** — a typed, multi-tenant **record store unified with hybrid
search** and citation-grounded RAG. Deterministic lookups and enumeration
*and* semantic search over one isolated, per-customer index of records and
documents — so an agent gets memory that's precise, not just fuzzy recall.
Reached agent-natively here over MCP (Claude Desktop, Cursor, Claude Code,
Cline, Continue, VS Code, hosted platforms) — and the same data is
human-accessible through the Vectros app + SDKs.

```
npx -y @vectros-ai/mcp-server
```

Your agent can search your indexed corpus, query structured records,
ingest documents, ask questions grounded against documents, and run the
agents you have stored. The server itself makes no call to the web; a stored
agent you run can search the web (`web_search`) or fetch a page (`web_fetch`)
when its definition lists that tool. Web fetch also needs your tenant's owner
to switch it on, and a run of an agent that lists `web_search` is refused while
the platform has web search disabled.

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

**Want to browse the data yourself?** `bootstrap` sets up the key for your
*agent*, not a login for *you* — so a blueprint's context won't appear in the
data-plane app's switcher until you join your own user to it (the app lists only
contexts your user has access in). Grant yourself a role once, either in the admin
app (**Access → Contexts → _your context_ → Profiles → Create profile**, pick
yourself from the by-email picker, choose a role — no raw id needed) or from the
CLI with `--principal me` (resolves to your own user):

```bash
vectros access grant --principal me --context <context-id> --role <role>
```

Blueprints that ship a human role (e.g. `agentic-sdlc`'s `editor`) let you use
`--role`; otherwise grant inline scopes with `--actions records:r,search:r,…`.

For scripted / agent use, set the sign-in token in the environment and skip
the prompts:

```bash
VECTROS_BOOTSTRAP_TOKEN=… npx -y @vectros-ai/cli bootstrap \
  --blueprint task-management --yes
```

Prefer to wire it up by hand? See **Configure manually** below.

## Connect from your client

| Client | One-click | Manual |
|---|---|---|
| **Claude Desktop** | [Desktop Extension (`.mcpb`)](https://github.com/vectros-ai/vectros-mcp-server/releases/latest/download/vectros.mcpb) — double-click, paste your key | [JSON snippet](#configure-manually-claude-desktop-or-any-mcp-client) |
| **Cursor** | [![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=vectros&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB2ZWN0cm9zLWFpL21jcC1zZXJ2ZXIiXSwiZW52Ijp7IlZFQ1RST1NfQVBJX0tFWSI6IiJ9fQ%3D%3D) | `.cursor/mcp.json`, same shape as below |
| **VS Code** | [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=vectros&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40vectros-ai%2Fmcp-server%22%5D%2C%22env%22%3A%7B%22VECTROS_API_KEY%22%3A%22%22%7D%7D) | `.vscode/mcp.json`, the same entry under a top-level `servers` key |
| **Claude Code** | `claude mcp add` (below) | [project `.mcp.json`](#configure-manually-claude-code) |
| **Cline / Continue** | — | same JSON snippet as Claude Desktop |
| **Smithery** | `npx -y @smithery/cli install @vectros-ai/mcp-server` | — |
| **Codex** | — | TOML snippet (below) |

The fastest path on **every** client is `npx -y @vectros-ai/cli bootstrap` — it
mints a scoped key and writes the config for you. The one-click buttons install
the server entry; you then supply the key (bootstrap, or paste your `ssk_...`).

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.vectros]
command = "npx"
args = ["-y", "@vectros-ai/mcp-server"]
env = { VECTROS_API_KEY = "ssk_live_..." }
```

## Honest caveats

Precision is the pitch — what this server deliberately does *not* do:

- **There's a human step.** Bootstrap needs a developer-portal sign-in / bridge
  token. One command, but a person signs in — there is no fully unattended
  provisioning.
- **Web search comes through your agents.** The server itself makes no call to the web:
  Vectros is the memory, not the browser. `agent_run` on a stored agent whose definition
  lists `web_search` or `web_fetch` can search the web or fetch a page; web fetch also
  needs your tenant's owner to switch it on, and web search needs the platform to have
  it enabled (otherwise the run is refused).
- **Agent document upload is text-inline.** An agent ingests document text
  inline; on the stdio transport a jailed local-file upload is supported, but
  bulk file upload from the agent surface isn't the path.
- **Audit history is tamper-*evident*, not tamper-proof.** A state-continuity
  chain makes out-of-band alteration *detectable*; it is not continuous
  automated verification.

## Configure manually (Claude Desktop or any MCP client)

If `@vectros-ai/cli` is installed **globally** (`npm install -g @vectros-ai/cli`,
not a one-off `npx` run — the server needs `vectros` to still be on `PATH`
later, when IT runs, not just while bootstrap ran) and you've run
`vectros bootstrap` with it, omit the `env` block entirely — the server
resolves your key from the local `vectros` CLI keyring automatically (see
[Credential resolution](#credential-resolution) below). `vectros login` alone
does **not** do this — it stores a separate sign-in session, not this key —
so `bootstrap` is the step that actually has to have run:

```json
{
  "mcpServers": {
    "vectros": {
      "command": "npx",
      "args": ["-y", "@vectros-ai/mcp-server"]
    }
  }
}
```

No CLI installed, or a machine you can't log in on? Set the key directly
instead:

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

This file lives under Claude Desktop's own per-user app-support directory,
not a shared repo — but a real key pasted into it is still a live secret at
rest: don't paste it into a chat, ticket, or screenshot with the value
intact, and prefer the keyring form above whenever you can.

Restart Claude Desktop. The agent now sees the Vectros tools and
two resources as callable surfaces.

## Configure manually (Claude Code)

Claude Code reads a project-scoped `.mcp.json` with the same shape.
**Never commit a real key into it** — `.mcp.json` is exactly the kind of file
teams check in to share a project's tooling, and a live `ssk_*`/`sk_*` value
inside it is a credential leak the moment it lands in git history, not just
if the repo is public.

The way to share this config safely: commit the entry with **no `env` block
at all**, and let each developer's own `vectros` CLI keyring supply the key
(see [Credential resolution](#credential-resolution) below — this is the
same delegation `git credential` / `docker-credential-*` use). This needs
each teammate to have `@vectros-ai/cli` installed **globally** and to have
run `vectros bootstrap` with it — `npx`-ing the CLI once, or running
`vectros login` alone (a separate sign-in session, not this key), leaves
nothing on `PATH` or in the keyring for the server to find later:

```json
{
  "mcpServers": {
    "vectros": {
      "command": "npx",
      "args": ["-y", "@vectros-ai/mcp-server"]
    }
  }
}
```

Or let Claude Code's CLI write that keyring-based entry for you:

```bash
claude mcp add vectros -- npx -y @vectros-ai/mcp-server
```

If a machine genuinely has no `vectros` CLI installed, you can pass the key
directly with `-e VECTROS_API_KEY=ssk_live_...` — but then keep that config
**local**: add `.mcp.json` to `.gitignore` first, rather than committing it
with the key inside.

Add `-e VECTROS_API_BASE_URL=<your environment's API base URL>` to point the server at a
different environment.

**Load it into a session by restarting.** A Claude Code session that was
already open when you added the server won't pick it up mid-session — fully
quit and reopen the project (not just re-select the tab). The `/mcp` panel
shows the connector marketplace, not locally-configured stdio servers, so it
won't confirm the server is loaded — ask the agent to call a Vectros tool
instead. Config is keyed by the **git common root**, so a linked worktree
resolves to its main repo's `.mcp.json` — add and open from the same project.

> **Windows note:** if your `.npmrc` (or a global npm config) points the
> `@vectros-ai` scope at another registry, a bare `npx -y @vectros-ai/mcp-server`
> can resolve a build other than the public release. If the command above fails
> to start, either remove the scoped-registry override for a plain `npx` run, or
> pin an explicit version (`npx -y @vectros-ai/mcp-server@<version>`) known to
> work.

## Tools (26 tools)

**Search & RAG**

| Tool | What it does |
|---|---|
| `hybrid_search` | Hybrid BM25 + dense search across the tenant's indexed content (records + documents). Narrow by ownership (`scope` for one dimension, `scopeFilters` for several at once — e.g. one client within one org), folder, type, metadata filters, a created date window, and keyword-precision (`textMode`) / relevance floors. Returns the indexed projection of each hit. |
| `rag_ask` | Ask a question grounded against the indexed corpus. Scope retrieval through `search` (ownership — `search.scope` or multi-dimension `search.scopeFilters` — / folder / type / metadata filters / date window) and steer generation (`instructions`, and `temperature` for the models that accept one). Streaming generation aggregated; progress notifications keep the call alive for the generation window. Optional `providerAlias` routes one call through your own model provider (see below). |
| `document_ask` | Ask a question grounded against a single document. Same aggregation + progress-notification shape as `rag_ask`, including the optional `providerAlias`. |

**Records** (structured, schema-validated data)

| Tool | What it does |
|---|---|
| `list_schemas` | List the record-schema catalog the credential can see (filter by `surface` or resolve one by `recordType`). Makes `record_query` / `record_create` discoverable. |
| `record_query` | Query records by lookup field — equality (`value`), range, or prefix, with `asc`/`desc` ordering and an optional `sortFrom`/`sortTo` window — or list mode, choosing one of `type`, `folderId` (every record in a folder, any type — combine with `type` to narrow), or `recent` (the account-wide recently-updated feed across all types), then optionally filtering the first two by ownership. Also supports composite equality across 2-3 fields (`values`), but only against a lookup the *schema* declares over those fields together (see `list_schemas`) — not any two fields you pick. |
| `record_get` | Fetch one record by id, including its full payload (large payloads truncated to protect the agent context window). |
| `record_batch_get` | Fetch several records by id (1-100) in one call, each with its full payload. Returns `missingIds` for any requested id you can't access, since the API silently omits them. |
| `record_create` | Create a record of a given type; idempotent by `externalId`; optional per-record `indexMode`. |
| `record_batch_write` | Create or upsert up to 50 records in one call, instead of N `record_create` round-trips. Items may mix types and are validated and scope-checked individually. `atomicity: all_or_nothing` commits them as one transaction (nothing is written if any item fails); the default `best_effort` writes each independently. Reports success whenever the batch was *processed* — read the per-item `results`, not just the absence of an error. |
| `record_update` | Patch a record's payload (deep-merged; `null` deletes a key); optimistic concurrency via `expectedVersion`. |
| `record_delete` | Permanently delete a record by id (leaves a tombstone). |

**Documents** (text/file content, indexed for search + Q&A)

| Tool | What it does |
|---|---|
| `document_ingest` | Create a document — inline text body OR local file upload (file mode is stdio-transport only). Idempotent by `externalId`; optional `schemaId` + `payload` for a typed, lookup-queryable document. An `externalId` with no `schemaId` is refused by platform 0.46.0 and later unless you also pass `confirmUntyped: true`. |
| `document_query` | Query documents by lookup field (equality / range / prefix, with `asc`/`desc` ordering) or list mode (filter by `type`, folder and ownership). The `type` list filter applies page by page: a page can be short or empty while `nextCursor` is set, so keep paging before concluding there are none, or use `hybrid_search` with `typeName` for a large collection. Lookup arguments without `field`, and an empty `type`, are refused. |
| `document_get` | Fetch a document by id (metadata incl. lifecycle `status` + processing `indexStatus`; optional text truncated at ~8K tokens; optional presigned `downloadUrl` for file-backed documents — always forces a download, never inline rendering, regardless of file type). |
| `document_update` | Patch a document's metadata / typed payload (deep-merged); archive/restore via `status` (`ARCHIVED` soft-retracts from search, `ACTIVE` restores); optimistic concurrency via `expectedVersion`. |
| `document_delete` | Permanently delete a document by id (removes it and its indexed content). |

**Folders** (group records + documents)

| Tool | What it does |
|---|---|
| `folder_query` | Get a folder by id, or list folders (a parent's children for tree navigation, or a flat tenant list; paginated via `nextCursor`). |
| `folder_create` | Create a folder. |
| `folder_update` | Update a folder's name / description / ownership (merge-patch; optimistic concurrency via `expectedVersion`; folders cannot be re-parented). |
| `folder_delete` | Delete a folder. It must be empty first — no documents, no records, and no sub-folders — and a context root is protected outright. |

**Identity & history**

| Tool | What it does |
|---|---|
| `current_identity` | Describe the credential: tenantId, environment, principalType, principalKeyId, principalLabel, and (for scoped credentials) allowedActions + dataScope. Does **not** include `granted_capabilities` (`member-lifecycle` / `forensic-read` / `context-directory-read` / `delegate-mint`, as of API 0.40.0, joined by `delegate-principal-stamp` in 0.42.0 and `trigger-control-plane-grant` in 0.44.0) — a separate reach dimension a scope clause can carry that `/v1/ping` doesn't report, so allowedActions + dataScope may understate a credential's true reach. Also reports this server's own version and the bundled SDK version (`mcpServerVersion`, `sdkVersion`). |
| `lookup_principal` | Resolve a user, or an identity entity in a namespace (`org`/`client`/any namespace you registered), by your own `externalId` (→ its Vectros UUID, for the ownership filters) or by a schema lookup field. Pass `contextId` to target a specific app context for a context-owned namespace. Read-only. |
| `version_history` | Read the audit/version trail (CREATE/UPDATE/DELETE, with actor + diff) for one record or document. Read-only. |

**Agents** (run the stored agents of your app context; defining or changing an agent is done through the API)

| Tool | What it does |
|---|---|
| `agent_list` | List the stored agents (running one needs `runs:c`), as each one's `id`, `name`, `description`, `latestVersion` and `status` (paginated via `nextCursor`; retired and purged agents only with `includeRetired`), in your credential's own app context, the one `agent_run` runs in. Needs `runs:c` or `agents:r`. Read-only. |
| `agent_run` | Run a stored agent on one `input` and return its answer: `{ runId, agentId, agentVersion, status, terminal, reason, errorCode, text, toolCalls, charged }`; `charged` carries the run's charge and refund in milli-cents (1 cent = 1000). `maxInferenceCents` caps the run's model cost (it can only lower the agent's own budget) and `readOnly` refuses every tool call that would change data. The run's tool calls act as you, with your permissions, and only through the tools the agent lists. Progress notifications keep the call alive while the run works (for a client that resets its timeout on progress); cancelling the call cancels the run once it is named. The server itself makes no call to the web; a stored agent can search the web or fetch a page when its definition lists that web tool (web fetch also needs your tenant's owner to switch it on, and web search needs the platform to have it enabled: otherwise the run is refused). Billed, and flagged destructive so your MCP client asks before it runs. Needs `runs:c`. |
| `run_get` | Read one run by id: `status`, `terminal`, `reason`, `errorCode`, its tool calls (never their arguments or results) and `usage`. Use it when `agent_run` returns `terminal: false`. Needs `runs:r`, which `runs:c` does not include. Read-only. |

**Running agents.** The three agent tools are registered by default, like every other tool, so **after upgrading,
an existing install (including `npx -y @vectros-ai/mcp-server`) offers them with no config change**, and one of
them, `agent_run`, **spends money and can change data**: it starts a billed run whose tool calls act with your
permissions. It is marked destructive, so an MCP client that honours tool annotations asks you before it runs; to
leave it out, use `VECTROS_MCP_TOOLS` below. A run is billed: its
model calls against your inference balance (a prepaid account reserves the budget when the run starts and returns
what was not used), and a fee per run, tool calls and run time against your plan. Three things on the platform side
decide whether a call can start a run at all:

1. **The credential needs the `runs:c` scope.** Without it `agent_run` returns `403`. Reading a run with `run_get`
   needs `runs:r` as well, which `runs:c` does not include: a credential with only `runs:c` learns how its runs end
   only from `agent_run`'s own result. `agent_list` works with `runs:c` or `agents:r`; a credential with only
   `agents:r` can list agents but not run them.
2. **Agent runs must be switched on for your tenant by an account owner.** Otherwise `agent_run` returns `403` with
   `errorCode: AGENT_RUNS_NOT_ENABLED`.
3. **The platform's run limits apply.** It limits how many runs one credential has in progress at once and how much
   budget they hold together; a call over either returns `429`. One MCP server runs on one credential, so all of its
   clients' concurrent `agent_run` calls share those limits.

To leave `agent_run` out of a server, set `VECTROS_MCP_TOOLS` to the tools you **do** want: it is an allow-list (the
server registers only the tools it names), not an exclusion list. For example, a server that can find and read
agents and runs but never start one:

```bash
VECTROS_MCP_TOOLS=hybrid_search,rag_ask,record_query,record_get,document_query,document_get,agent_list,run_get
```

**Retries.** Every `agent_run` call sends an `Idempotency-Key`, so the SDK's own retries of a refused start never
begin a second run. Calling `agent_run` again without a key starts a new, billed run: to make your retry of a whole
call safe, pass the same `idempotencyKey` with the same arguments, and the call names the run that key already
started instead of starting another (its answer text is not returned again, and `run_get` cannot read it back; the
same key with different arguments is refused with `422`). A start that fails without a clear refusal (a dropped
connection, a timeout, a `408` or a `5xx`) may still have started a run, so its error names the `idempotencyKey` to retry with.

**Cancelling and long runs.** Cancelling the call cancels the run once the run is named (the response names it
almost at once; a cancel that arrives earlier waits for the name). If the start itself then fails, nothing could be
cancelled: retry with the key the error names to find the run. Progress notifications are sent only when the MCP
client supplies a `progressToken` with the call, and they keep a long call alive only for a client that resets its
request timeout on progress; a client with a fixed timeout ends the call (and so the run) when it expires. A result with `terminal: false` arrived before the run ended: read the run with `run_get` until
`terminal` is true. `run_get` returns the run as the API reports it and never returns the answer text.

All 26 tools wrap published Vectros HTTP API endpoints. JSON
responses are what the agent sees as tool output. Per-call cost
surfaces in the `usage` field of `rag_ask` and `document_ask` results: the token counts,
`platformCreditsCharged`, and the model cost as `inferenceBalanceCentsChargedMilli`, in
milli-cents (1 cent = 1000). `agent_run` reports a run's charge the same way, in its
`charged` field.

**Concurrent updates.** `record_update`, `document_update`, `folder_update` and `document_ingest` with `upsert: true`
return `409` (`errorCode: VERSION_CONFLICT`) when another request changed the same item at the same moment, whether or not
you pass `expectedVersion`. Nothing is written and the other change is kept: re-read the item and retry.
`expectedVersion` still refuses an update made against a version you read earlier, even if the other change finished long
ago. An update to an item that was deleted a moment earlier returns `404`. In `record_batch_write` with `upsert`, an item
that meets another change at the same moment is reported in the results with `status: conflict` and
`errorCode: VERSION_CONFLICT`; send that item again. Items written with `atomicity: all_or_nothing` are not covered.

**Items of a deleted schema.** An item whose schema no longer exists is not served: reading it (`record_get`,
`document_get`) returns an error, updating it, reading its `version_history`, and reading a document's text, download or
answers (`document_ask`) are refused, and `record_query`, `document_query` and `record_batch_get` leave it out. Delete the
item.

### Routing a call through your own model provider

`rag_ask` and `document_ask` take an optional `providerAlias`: the alias of a model provider config your Vectros
account has activated. When you pass it, that one call is served by your own provider instead of the
platform-hosted default, and `model` then names a model on your provider's own id space (it falls back to that
provider config's default model when omitted). The server forwards `providerAlias` only when you supply it and
never fills it in.

It works only after your account has set up the provider and signed the platform's risk-acceptance waiver. Without
both, the platform refuses the call with a `403`, which the tool returns to you as written. When the waiver is the
cause, the `403` carries an `errorCode` that says which case it is: `WAIVER_NOT_SIGNED` (the waiver has not been
signed), `WAIVER_TEXT_CHANGED` (Vectros now requires a newer version of the waiver than the one in force for your
account) or `WAIVER_REVOKED` (an account owner revoked it). An account owner resolves each in the developer portal
(**Model Providers**); retrying the call does not help.

If your account has accepted the Business Associate Agreement with Vectros in the developer portal, an account owner must also attest each provider
config in the developer portal (**Model Providers**) before a call can use it. Until then the platform refuses the
call with a `403` that says it needs a BAA-holder attestation. The owner does this in the portal; nothing in this
server does it.

A call served by your own provider leaves the platform-hosted Bedrock path, and Vectros's AWS BAA boundary, so
decide deliberately whether a given call should use it. Nothing here is a statement about how a provider you chose handles your data.

### Opting into a subset

Pass `VECTROS_MCP_TOOLS=hybrid_search,record_query,record_get` to register only those
three — useful for giving an agent read-only access without
exposing ingestion or inference costs to the credential. Add `rag_ask` or `document_ask`
only if the credential should be able to spend inference balance. Unknown tool
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
across one org scope (`scope:org`). If your MCP install is compromised, the blast
radius is whatever the profile allows, not the whole tenant. The
server emits a `warn` log line on startup when you pass a wildcard
`sk_*` for exactly this reason.

**The easiest way to get one is `npx -y @vectros-ai/cli bootstrap` (above)**
— it mints a least-privilege `ssk_*` and an AccessProfile for you, no root
key required. To do it by hand instead: mint a scoped key from the developer
portal under **Keys → Create scoped key**, bind it to a read-only AccessProfile
(any name, for example `mcp-read`), and drop the resulting
`ssk_live_...` into the config above.

See the Vectros developer documentation on scoped tokens for least-privilege credential setup — the
`vectros bootstrap` flow provisions a scoped `ssk_*` key and its AccessProfile
in one command.

> **A root `sk_*` can no longer file into another app context, as of API 0.43.0.**
> If you run this server on a root key and a tool call names a `folderId` /
> `parentFolderId` — or a `schemaId` on a document — belonging to a context other
> than `default`, it is now refused with a uniform `400 "Folder not found"` /
> `"Schema not found"`. This affects `document_ingest`, `document_update`,
> `record_create`, `record_update` and `folder_create`, and it is a change in
> outcome: those calls used to succeed. They never did what they appeared to,
> though — a root key's writes are always stamped `default`, so the row landed in
> `default` while its folder or schema lived elsewhere, permanently invisible to
> the context that owned them. Existing rows written the old way are untouched and
> still readable, updatable and deletable. The fix is the same scoped key
> recommended above: one bound to the target context can file into it and always
> could.

## Credential resolution

The server resolves its API key from the first source that yields one:

1. **`VECTROS_API_KEY`** — always wins when set.
2. **The `vectros` CLI keyring** — if the key is unset and
   [`@vectros-ai/cli`](https://www.npmjs.com/package/@vectros-ai/cli) **0.9.0+** is on
   your `PATH`, the server runs `vectros keyring show --format raw` as a subprocess
   and uses the key it prints. By default that is your **active** identity; set
   `VECTROS_KEYRING_ALIAS` to pick a specific entry. This is the same pattern as
   `git credential` / `docker-credential-*` / `aws credential_process`: the key
   lives in one place, and the server, your scripts, and your agent hooks all read
   it from there instead of each keeping a plaintext copy that drifts.
3. **Neither** — startup fails with a message naming both options.

The resolved key is held in memory and never logged. Startup logs which alias it
resolved (not the key), so you can tell at a glance which identity the server is
running as — `vectros keyring doctor` (CLI 0.10.0+) shows the same view.

> **Startup warns when it picks an identity you didn't name.** If `VECTROS_API_KEY`
> is unset and no `VECTROS_KEYRING_ALIAS` is set, the server falls back to your
> **active** keyring entry and logs a warning — it is running as whatever identity
> `vectros switch` last selected, which may be a `ssk_live_*` key acting on real data
> or a `ssk_test_*` one that isn't. Either can be an unwelcome surprise, because a
> blank placeholder (`"VECTROS_API_KEY": ""` in a client config, or `-e VECTROS_API_KEY`
> passing through an unset var in Docker) reads as "not configured yet" but resolves
> like an unset key. Nothing is blocked — name an entry with `VECTROS_KEYRING_ALIAS`,
> or set `VECTROS_API_KEY`, and the warning goes away. `vectros keyring doctor` (CLI 0.10.0+) shows
> which entry is active and which of your keys are live.

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `VECTROS_API_KEY` | no\* | — | Vectros API key. Accepts `sk_*` / `ssk_*` / `st_*`; `ssk_*` recommended. \*Required **unless** the `vectros` CLI is installed with a usable keyring entry — see [Credential resolution](#credential-resolution). Takes precedence when set. |
| `VECTROS_KEYRING_ALIAS` | no | (the active entry) | Resolve this `vectros` keyring entry instead of the active one. Ignored when `VECTROS_API_KEY` is set. |
| `VECTROS_API_BASE_URL` | no | `https://api.vectros.ai` | Override for another environment. Validated: must be `https://` (or `http://` to localhost) and an official `*.vectros.ai` host. |
| `VECTROS_ALLOW_INSECURE_BASE_URL` | no | — | Set `1` to bypass the base-URL allow-list (e.g. a trusted local proxy). **Not recommended** — sends your key to an unvalidated host; logs a warning. |
| `VECTROS_MCP_INGEST_ROOT` | no | process cwd | Directory `document_ingest`'s `filePath` mode is jailed to. Paths escaping it (traversal/absolute/symlink) or matching a sensitive pattern are rejected. |
| `VECTROS_MCP_TOOLS` | no | (all tools) | Allow-list of tool names, comma-separated (e.g. `hybrid_search,rag_ask`): only these are registered. |
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
  npx -y -p @vectros-ai/mcp-server vectros-mcp-server-http
```

> The HTTP binary is **not** the default — select it explicitly with
> `npx -p <pkg> vectros-mcp-server-http`. A bare `npx -y @vectros-ai/mcp-server`
> always starts the stdio server.

The server listens on `http://127.0.0.1:8765/mcp` by default. The
bearer token is optional but **strongly recommended for any
deployment beyond localhost** — without it, anyone who can reach the
port can call Vectros with your credentials.

Health probe lives at `GET /healthz` (always unauthenticated, k8s
readiness-friendly).

The server uses one upstream credential per process (the key resolved at
startup); the incoming Authorization header is not used to choose another.
Deploy one server per credential boundary you want.

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

## What this server deliberately doesn't expose

This is a decision, not a backlog. An MCP server is a tool surface handed to an
autonomous caller, so a capability the API offers is not automatically a tool —
each one has to earn its place on an agent's surface.

The line is the **data plane**: records, documents, folders and search are here in
full. Anything that grants or administers authority is not, and neither is the
design-time layer that defines the data model.

- **Stored scripts** (`/v1/scripts` — push, list, fetch, delete). A stored script is
  code, not data. Authoring it is a design-time act, the same reason schema mutation
  lives in the CLI rather than here: an agent that can write the code that later runs
  under your credential is a different proposition from one that can write records.
- **Synchronous script execution** (`POST /v1/scripts/execute`, the `scripts:x` scope).
  The closer call of the two, and excluded on operational grounds rather than reach —
  a `scripts:x:<name>` grant is a deliberately narrow, per-script permission, and an
  ordinary scoped key can hold it. What an agent handles badly is the failure surface:
  a run whose outcome cannot be determined returns `500 EXECUTION_OUTCOME_UNKNOWN` with
  writes that may or may not have committed, which is not something a caller resolves
  by retrying — it has to go and look. Getting a retry right also means reusing an
  `Idempotency-Key` across attempts, and a tool call has no natural retry identity, so
  an agent re-invoking after a timeout would silently run the script a second time.
  Exposing this well needs a deliberate design for those two things, not a thin wrapper.
  Until then, run scripts from a caller that can handle them — the API, the SDK, or the
  CLI.
- **Trigger rules** (`/v1/triggers`). Declaring a rule grants authority — a rule's
  `scopes`/`roleIds` are live, and declaring one is scope-monotonicity-checked like
  any other authority-granting surface. Minting authority is not an agent action.
- **Trigger failure history** (`GET /v1/trigger-failures`) and **usage/billing**
  (`GET /v1/usage`). Both are read-only, and both are operational rather than
  data-plane — they describe how your automation and your account are behaving, not
  what your content says. That is a question for the developer portal or the CLI,
  where a person is looking at it, rather than a tool an agent reaches for mid-task.
- **Identity, access and credential administration** — users, access profiles,
  roles, app contexts, issuer registrations, and scoped-key minting. Unchanged
  since launch: identity CRUD stays off the agent tool surface by design.
  `lookup_principal` resolves an identifier to an id and does nothing else.
- **Compliance operations** (erasure, export). Same reason.

If one of these belongs on your agent's surface, that's worth telling us — the
line is drawn on purpose and can be redrawn with a reason.

## What this server doesn't do

- **No prompts capability** — the server offers tools and resources, not
  slash-command templates. (Provisioning — the `bootstrap` command — lives
  in the separate [`@vectros-ai/cli`](https://www.npmjs.com/package/@vectros-ai/cli)
  package, above.)
- **HTTP transport is single-tenant per process** — it does not take a
  per-request credential from the incoming Authorization header.
- **No Python implementation** — TS only. Python users can `npx`
  this server from any project.
- **`rag_ask` and `document_ask` are not natively streaming** —
  full answer aggregated before the tool returns. Progress
  notifications cover the latency.

The server is pre-1.0; the [CHANGELOG](./CHANGELOG.md) lists what changed in each release.

## Rate limits

Tool calls hit the same per-minute rate limits as any API client; the
[rate limits guide](https://docs.vectros.ai/guides/operations-trust/rate-limits) says which requests count. On a rate-limit `429` the tool returns the error with `HTTP 429` and `errorCode: RATE_LIMITED`, so the agent can pace and retry
rather than blind-retrying. `rag_ask` and `document_ask` can also return `429` with `errorCode: BALANCE_BUSY` (your pre-paid
balance is momentarily busy with your other concurrent requests: not a rate limit and not a shortage, so do not top up;
retry shortly) or `503` with `errorCode: BALANCE_UNAVAILABLE` (a temporary fault interrupted the balance step; also not a
shortage; retry shortly). A `402` means the balance is short (`INSUFFICIENT_BALANCE`) or the plan's usage limit is reached (`SUBSCRIPTION_LIMIT_EXCEEDED`). A `503` with no `errorCode` on a call that names a `providerAlias` means the platform cannot open the stored provider key: retry shortly, and enter the key again in the developer portal if it persists. The tool returns the message, `errorCode` and
`requestId`, not the `Retry-After` header. The guide also lists
the per-plan limits.

## Building from source

```sh
git clone https://github.com/vectros-ai/vectros-mcp-server
cd vectros-mcp-server
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

## Security & trust

Vectros enforces per-customer, fail-closed isolation and least-privilege scoped keys, with a
tamper-evident audit and version history. Customer-facing surfaces are hardened through extensive
adversarial security review. For the full trust posture, drawn plainly with its boundaries, see the
[compliance and trust guide](https://docs.vectros.ai/guides/operations-trust/compliance).

**Tool output is untrusted, API-supplied content.** Every tool here returns your own tenant's data —
document text, search results, error messages — as plain text inside the MCP response. This server
does not sanitize, escape, or pre-render that text, and none of these tools evaluate or execute it.
Render tool output the same way you'd render any other data an agent pulled from an external source
— safely, in your client — rather than `eval`-ing it or trusting it as pre-sanitized.

## License

Apache-2.0. See the LICENSE file.
