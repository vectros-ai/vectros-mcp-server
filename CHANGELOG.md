# Changelog

All notable changes to `@vectros-ai/mcp-server` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

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
