# Changelog

All notable changes to `@vectros-ai/mcp-server` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.6.0 — 2026-07-03

Curation-focused tool improvements: look records and documents up by your own
identifier, re-sync a changed body, archive and restore documents without delete
authority, and get a clear error when an argument is wrong.

### Added

- **`externalId` selector on `record_get`, `record_update`, `document_get`, and
  `document_update`.** Pass `externalId` together with `type` as an alternative to the
  Vectros `id` — the tool resolves it for you, so an agent that only knows its own
  identifier no longer has to make a separate lookup call first. `id` still works and
  takes precedence when both are supplied.
- **`upsert` on `document_ingest`.** With `upsert: true`, ingesting a document whose
  `externalId` already exists overwrites its stored content and re-indexes it, instead
  of returning the existing document unchanged. Re-supply the same `schemaId` so the
  `externalId` resolves within the same type.
- **`text` on `document_update`.** Replace a text document's body in place; the document
  is re-queued for indexing so search reflects the new content.
- **`status` on `document_update` — archive and restore a document.** Set
  `status: "ARCHIVED"` to soft-retract a document: it is pulled from search and recall
  but kept and recoverable. Set `status: "ACTIVE"` to re-index and restore it. This is
  the way to retire superseded content with a credential that has no delete authority.
  Document reads (`document_get`, `document_query`) surface the caller-controlled
  lifecycle `status` alongside the read-only processing `indexStatus`.
- **`hybrid_search` results are now sized for an agent's context window.** Each hit returns
  its matched `chunkText` plus a short `snippet` by default; the broader surrounding passage
  (`contextText`) is opt-in via **`includeContext: true`** (and is de-duplicated against
  `chunkText` when included, so the same text is never sent twice). Internal search-index
  bookkeeping fields (`tenantId`, `owner_id`, `model_type`, `rootFolderId`, `folderId`) are
  stripped from each hit's `metadata`, keeping the fields you ingested. An oversized response
  is trimmed to the top hits with **`truncated: true`** so one search can't overflow the
  context window. A **`textLegEmpty: true`** flag signals that the keyword (BM25) leg matched
  nothing across every hit — usually a long natural-language query under the default
  `PHRASE` matching; retry with a short keyword phrase or `textMode: "OR"`.

### Changed

- Updated the bundled `@vectros-ai/sdk` to **0.32.0**, keeping the server aligned
  with the current Vectros API (adds the document lifecycle `status` field, kept
  distinct from the processing `indexStatus`).
- **Document responses keep the two status axes separate.** `status` is the
  caller-controlled lifecycle (`ACTIVE`/`ARCHIVED`); `indexStatus` is the read-only
  processing state (`PENDING_INDEX`, `INDEXED`, …), matching the current API.
  `document_ingest`'s file mode accordingly reports its "uploaded, indexing queued"
  marker as `indexStatus: "PENDING_INDEX"` — previously it overwrote `status` with
  that value. Poll `document_get` until `indexStatus` is `INDEXED`.
- **Unknown arguments are now rejected, not ignored.** Calling a tool with an argument
  it does not accept returns an error that names the unrecognized key and lists the
  valid arguments for that tool, instead of silently dropping it. This surfaces typos
  and stale parameter names immediately rather than letting a call quietly do the wrong
  thing. `record_query`'s `field` documentation now also calls out that `externalId` is
  always queryable.

## 0.5.3 — 2026-06-29

SDK refresh. No tool, parameter, or result shapes changed.

### Changed

- Updated the bundled `@vectros-ai/sdk` to **0.31.0**, keeping the server aligned
  with the current Vectros API (create endpoints now report whether a resource was
  newly created and accept an opt-in `upsert`). The `record_create`, `folder_create`,
  and `document_ingest` tools were adjusted to the regenerated client's request shape;
  their MCP-facing inputs and outputs are unchanged.

## 0.5.2 — 2026-06-26

Distribution fix + SDK refresh. No tool, parameter, or result shapes changed.

### Fixed

- `npx -y @vectros-ai/mcp-server` now starts the (stdio) server directly. The
  package previously exposed only `vectros-mcp-server` and
  `vectros-mcp-server-http`, so a bare `npx -y @vectros-ai/mcp-server` — the form
  used in every client config and registry listing — could not pick a binary and
  failed with *"could not determine executable to run."* A `mcp-server` binary
  (matching the package's unscoped name) now makes the bare invocation resolve to
  the stdio server. The explicit `vectros-mcp-server` / `vectros-mcp-server-http`
  binaries are unchanged.

### Changed

- Updated the bundled `@vectros-ai/sdk` to **0.30.0**, keeping the server aligned
  with the current Vectros API.

### Added

- A `server.json` manifest (official MCP Registry schema) at the repository root,
  plus one-click install artifacts: a Claude Desktop Extension (`.mcpb`),
  `smithery.yaml`, and "Add to Cursor" / VS Code install links.

## 0.5.1 — 2026-06-25

Maintenance — refreshed the bundled Vectros SDK to the current API surface.

### Changed

- Updated the bundled `@vectros-ai/sdk` to **0.29.9**, keeping the server aligned
  with the current Vectros API. Records and documents with no searchable text now
  report the `SKIPPED` index status (stored and retrievable, simply not indexed)
  rather than `FAILED`. No tools, parameters, or results changed shape.

## 0.5.0 — 2026-06-20

Initial public release of the Vectros MCP server.

### Added

- A [Model Context Protocol](https://modelcontextprotocol.io) server exposing the
  Vectros data plane to MCP-aware agents (Claude Desktop, Cursor, Code, Cline,
  Continue, VS Code, and hosted agent platforms) as **21 data-plane tools** — and
  only data-plane tools (no web or external-search surface, by design).
- Full data-plane coverage:
  - **Hybrid search** with keyword-precision and relevance controls, ownership /
    folder / type / metadata / date scoping.
  - **Structured records** — create / read / update / delete / query, with field
    lookups (equality, range, prefix; ascending or descending) and idempotent
    create by `externalId`.
  - **Documents** — idempotent, optionally-typed ingest (inline text or file
    upload), retrieval (metadata, text, or a presigned download URL), update,
    delete, and query / lookup.
  - **Folders** — create / read / update / delete, with pagination.
  - **In-perimeter inference** — retrieval-augmented generation (with retrieval
    scoping and prompt steering) and single-document Q&A.
  - **Discovery & history** — schema catalog, current-credential identity,
    identity resolution (look up a user / org / client by your own id), and
    record / document version history.
- Optimistic concurrency (`expectedVersion`) on record / document / folder
  updates; results are bounded with MCP-specific limits to protect the agent
  context window.
- One-command start: `npx -y @vectros-ai/mcp-server`.
- Pairs with `@vectros-ai/cli bootstrap`, which mints a least-privilege scoped
  key so the server never needs your root credential.
- Fail-closed configuration: the server refuses to start on a missing or invalid
  base URL, or on an insecure network bind.
