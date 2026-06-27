# Changelog

All notable changes to `@vectros-ai/mcp-server` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

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
