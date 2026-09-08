# Changelog

All notable changes to `@vectros-ai/mcp-server` are documented here.
This project adheres to [Semantic Versioning](https://semver.org).

## 0.17.0 — 2026-09-07

### Added

- **`record_batch_write`** — create or upsert up to 50 structured records in one call,
  wrapping `POST /v1/records/batch` (API 0.43.0: previously a `501` stub, now live).
  Use it instead of N `record_create` round-trips when you hold several records.
  Items may mix types, and each one goes through the same schema validation,
  `externalId` idempotency, unique-field enforcement and `records:c:<type>` scope
  check as a single create, applied per item against that item's own type — a batch
  is not a way to write a type your credential could not write one at a time.
  `atomicity: "all_or_nothing"` commits every item in one transaction and writes
  nothing at all if any item fails, which is a better failure shape for an agent than
  a loop of creates that half-succeeds; the default `best_effort` writes each item
  independently. The item vocabulary deliberately mirrors `record_create` (`type` +
  `fields`), so nothing new has to be learned to use it.

  **The call reports success whenever the batch was *processed* — including when
  every item failed.** That is the endpoint's own contract, so the tool does not
  fake an error result; read the per-item `results` (matched to what you sent by
  `index`) and the `succeeded`/`failed` counts. Per-item `status` carries two values
  beyond the ordinary outcomes, and they call for different remedies:
  `forbidden` (your credential lacked the scope or ownership that item needed — fix
  the credential, not the item) and `not_committed` (this item was fine, but an
  `all_or_nothing` batch was aborted by a different one).

- **`record_query` can list by `folderId`, and serve the account-wide `recent` feed.**
  Two list-mode selectors the API has carried on `GET /v1/records` for many releases
  but this tool never exposed: `folderId` lists every record filed in a folder
  regardless of type (combine with `type` for one type within one folder), and
  `recent: true` returns the recently-updated feed across all types — the only way to
  read records without naming a type. `record_create` has always accepted `folderId`,
  so until now a record could be filed into a folder and never listed back out of it.

  This matters more from 0.43.0 on, because `folder_delete` now refuses a folder that
  still holds records and the supported way to find them is exactly this call.
  `type` is consequently optional now: a lookup (`field`) still requires it, a list
  with no selector at all is refused, and `recent` is refused alongside
  `type`/`folderId`/`userId`/`scope` rather than silently ignoring them the way the
  API does.

- **`scopeFilters` on `hybrid_search` and `rag_ask`** — narrow a search or a RAG
  retrieval by more than one ownership dimension at once, e.g.
  `["org:<id>", "client:<id>"]` for one specific client within one specific org.
  Something `scope` alone could not express, for a credential whose access spans
  several dimensions. Mutually exclusive with `scope`; passing both is refused
  locally with a message naming both fields, rather than spending a round trip on
  the API's own rejection.

### Changed

- **`folder_delete` now states its emptiness precondition** — the folder must contain
  no documents, **no records**, and no sub-folders, and the description says how to clear
  each: a document can be moved out or deleted, a record can only be deleted (nothing on
  this surface moves one), and a sub-folder cannot be re-parented, so nesting must be
  cleared innermost-first. The description previously named only protected folders, so
  the most common way this call fails read as impossible.

  **API 0.43.0 widened the refusal, and it lands harder on this server than on most
  callers.** The old guard saw sub-folders and *file-backed* documents only — it was blind
  to *text-ingested* documents and to records, and a delete that hit one of those returned
  success while orphaning the contents behind a folder id that no longer resolved.
  Text-inline ingest is `document_ingest`'s default path, so folders this server filled are
  precisely the ones whose deletes used to succeed and now do not.

  One consequence worth planning for: the emptiness check counts **everything** in the
  folder, including items the calling credential cannot read. A scoped credential can be
  refused by content it has no way to enumerate, so a refusal that contradicts your own
  listing is expected rather than a bug.
- **`rag_ask`'s `truncationWarning` now carries `truncatedCount` and `noContentCount`**,
  and its `reason` can be `no_groundable_content` or `context_window_budget_and_no_content`
  as well as `context_window_budget`. Results can be dropped before the prompt is built
  for two independent reasons — not fitting the context window, or having no groundable
  text at all — and these separate them. Inherited from the API with no code change here;
  noted because it is new data an agent sees.
- **`hybrid_search`'s ARCHIVED note now covers records, and stops claiming an absolute.**
  It said ARCHIVED *documents* never appear in results, which read as an asymmetry implying
  archived records still match — they do not, and have refused to index since API 0.35.
  API 0.43.0 additionally fixed two document write paths that could silently re-index an
  already-archived document. But it deliberately does **not** sweep items already stranded
  in that state: they stay searchable until written to again. So "never appear" was a false
  absolute, and the description now names the repair — re-send `status: "ARCHIVED"` on the
  item — instead of implying the case cannot arise.
- **A search hit's returned `createdAt` is documented as the INDEX timestamp.** It is the moment
  the item entered the search index — the same moment it was created in the common case, but later
  for anything re-indexed since — so it should not be reported to a user as the creation time; fetch
  the item with `document_get`/`record_get` for that. The `createdAfter`/`createdBefore` FILTERS are a
  separate thing and are unchanged: they filter on the item's true creation time, which does not move
  when it is re-indexed, with a bounded allowance that lets an item matched on its FIRST index be
  checked against its index time instead (clock skew between creating and indexing).
- **`folder_delete` no longer implies a record cannot be moved.** It said a record must be deleted
  because it cannot be re-filed. The API supports re-filing one (`folderId` is patchable); it is
  *this server* that does not expose it — `record_update` has no `folderId` argument. As written, an
  agent clearing a folder could have deleted partner data where a move was available, then reported
  that a move was impossible. It now names the gap as this server's and says to move the record
  through the API/SDK rather than deleting it here.
- **`record_batch_write` no longer claims duplicate `externalId`s within one batch are refused.**
  That holds under `atomicity: "all_or_nothing"` only. Under the default `best_effort` each item is
  written independently, so a second item carrying the same `externalId` matches what the first just
  wrote and reports `updated` — a duplicated key silently collapses two rows into one, counted as a
  success. Both modes are now described.
- **`record_create` / `record_batch_write`: `scopes` is bounded by `data_scope`, not by identity.**
  Both said the values "must come from the credential's own identity". The platform states the
  opposite: identity supplies the DEFAULT when you state none and does not limit which value you may
  state; each entry must fall inside the `data_scope` of a granting clause. The old wording would
  stop an agent setting a scope it was entitled to set.
- **`record_query` rejects `folderId`/`recent` on a lookup** instead of ignoring them, matching the
  existing guard for lookup arguments passed without `field`.
- **Bundled `@vectros-ai/sdk` repinned to the 0.43.0 line.**

### Notes

- **A root `sk_*` key can no longer file into a non-`default` app context.** As of API
  0.43.0, a `folderId` / `parentFolderId` — or a document's `schemaId` — belonging to
  another context is refused with a uniform `400`, on `document_ingest`,
  `document_update`, `record_create`, `record_update` and `folder_create`. Those calls
  previously succeeded, but never coherently: a root key's writes are stamped
  `default`, so the row landed in `default` while its folder or schema lived elsewhere.
  Existing rows are unaffected. Use a scoped key bound to the target context — the
  credential this server recommends anyway. See README § Recommended credential.
- **A `filters` clause on `status` means something different for records now.** Records
  no longer publish their lifecycle `status` into the search index (API 0.43.0), so on
  `hybrid_search` / `rag_ask` a `status` filter matches a schema's own `status` field
  where one is declared, and nothing where none is — it no longer collides with the
  platform's lifecycle value. Record schemas can now use `status` as a filterable field
  of their own.
- **0.43.0 capabilities this server deliberately does not expose:** stored scripts and
  synchronous script execution, trigger rules, trigger-failure history, and usage
  reporting. The reasoning is in README § What this server deliberately doesn't expose
  — briefly: authoring stored code is a design-time act rather than a data-plane one;
  declaring a trigger rule grants live authority; trigger-failure and usage reporting
  are operational questions for a person, not mid-task tool calls; and synchronous
  script execution has a failure surface (an undetermined-outcome run, and an
  idempotency key a tool call has no natural identity for) that needs a deliberate
  design rather than a thin wrapper.

## 0.16.1 — 2026-08-27

### Fixed

- **Claude Code setup docs: restart-to-load + Windows npx-resolution caveats.**
  The "Configure manually (Claude Code)" section now covers three real
  friction points found in dogfooding: a session already open when the
  server is added needs a full quit + reopen (not just re-selecting the
  tab); the `/mcp` panel shows the connector marketplace, not local stdio
  servers, so it can't confirm the server loaded; and config resolves off
  the git common root, so a linked worktree needs adding/opening from the
  same project as its main repo. Also documents a Windows-specific trap: a
  scoped-registry override for `@vectros-ai` in `.npmrc` can silently
  resolve `npx -y @vectros-ai/mcp-server` to an unexpected internal build
  that isn't guaranteed to run there — pin an explicit version if the
  plain command fails to start.
- **`current_identity`'s `granted_capabilities` note now lists all five named capabilities.**
  The tool description and the `identity` resource both listed only four
  (`member-lifecycle` / `forensic-read` / `context-directory-read` / `delegate-mint`); the
  platform's fifth, `delegate-principal-stamp`, is now named alongside them.

### Changed

- Bundled `@vectros-ai/sdk` refreshed to the current release's staging build.

## 0.16.0 — 2026-08-27

### Added

- **`record_batch_get`** — fetch several structured records by id (1-100) in one call, each with its
  full payload, wrapping `POST /v1/records/batch-get` (0.41.0: previously a `501` stub, now live).
  Complements `record_get`: use this instead of N single-id calls when you already hold several ids
  (e.g. hydrating a page of `record_query`/`hybrid_search` results). The API silently omits any id you
  can't access with no per-id existence signal; the response also carries `missingIds` — every
  requested id not present in `data` — so a caller can tell a partial result from a complete one
  without diffing it by hand. Same per-record payload-truncation guard as `record_get`.
- **Repinned to `@vectros-ai/sdk` 0.41.0** for the above. No other 0.41.0 surface change is consumed:
  the issuer-update endpoint and the `roleIds` access-profile field are identity/access administration
  this server's tools deliberately don't touch (`lookup_principal`'s own docstring: "identity CRUD
  stays off the agent tool surface by design"); entity responses' new `contextId` field already flows
  through `lookup_principal`'s pass-through JSON with no code change.

## 0.15.0

### Added

- **`lookup_principal` accepts an optional `contextId`** for entity kinds (`org`/`client`/any
  namespace you registered — not `user`, which is always tenant-wide). A namespace registration
  can now be tenant-wide or owned by one app context (API 0.40.0). A context-confined credential's
  own context resolves automatically without this; an unconfined (root-key) credential needs
  `contextId` to reach a context-owned namespace's entities — omitting it previously read back an
  empty result with no indication why. Two rejections come with it: supplying `contextId` with
  `kind: "user"` now returns `isError: true` immediately (the user surface is always tenant-wide);
  supplying it against a namespace that turns out to be tenant-wide is rejected by the API with a
  `400`.

### Changed

- **Repinned to `@vectros-ai/sdk` 0.40.0.**
- **`current_identity` (and the `identity` resource) now note that `granted_capabilities` — a scope
  clause's API-0.40.0 reach dimension (`member-lifecycle` / `forensic-read` / `context-directory-read`
  / `delegate-mint`) — isn't reported by `/v1/ping` yet**, so `allowedActions` + `dataScope` may
  understate a credential's true reach. This is a description-accuracy fix (the tool no longer implies
  it shows the complete picture); no new field ships, since the backend doesn't emit one yet.

## 0.14.0

### Changed

- **Repinned to `@vectros-ai/sdk` 0.39.0.**
- **The `st_*` short-lived-token warning now states a 1-hour maximum, matching the
  platform's narrowed cap** — it previously read "(1h default, 24h max)"; the 24h
  ceiling no longer exists, so it now reads "(1h max)".

## 0.13.0

### Added

- **`record_query` can now look up a record by several fields at once — for a
  type whose schema declares a lookup over those fields together** (not any
  two fields you pick; see the type's schema, e.g. via `list_schemas`). Pass
  the comma-joined field names (e.g. `"status,area"`) with one value per field
  in the new `values` array — or a single `value`, which is exactly a
  one-element `values` (matches the first named field, grouping by the rest).
  Supplying fewer values than the lookup declares — as long as they're a
  leading run of its fields — returns records grouped by the fields left
  unspecified; `from`/`to`/`prefix` are not valid on a composite field
  (exact-match only). Also new: `sortFrom`/`sortTo` narrow an exact-match
  (`value` or a full `values`) lookup to a window of the field's sort key
  instead of paging the whole match. Record lookups only; document lookups
  are unchanged.
- **`current_identity` (and the `identity` resource) now report `mcpServerVersion` and
  `sdkVersion`**, so you can tell exactly which server build and bundled SDK version a
  running instance is talking with.

### Fixed

- **`list_schemas` (and the `schemas` resource) no longer risk hanging on an unusual
  empty-page response.** Draining the schema catalog now stops with a clear error
  instead of paging forever if the backend ever returns an empty page alongside a
  cursor that keeps claiming more remain.

### Changed

- **Dependency maintenance** — repinned the bundled `@vectros-ai/sdk` to `0.38.0`.
  This pulls in a **Vectros API-side** pagination fix (distinct from the client-side
  guard above): a listing or lookup could previously report itself complete while
  results remained on a large page read; the API itself now always pages correctly,
  and every tool here that pages already trusted the cursor rather than the page
  size, so this is inherited automatically.

## 0.12.0

### Fixed

- **`document_get`/`document_update` selector errors now name the right parameter.**
  Calling either tool with a bad or missing selector previously told you to
  "provide `id`" — but their actual parameter is `documentId`; `id` isn't
  recognized at all. A caller reasonably assuming symmetry with `record_get`
  (which genuinely does use `id`) got an error message that appeared to confirm
  the wrong fix. Both selector-validation messages now say `documentId`;
  `record_get`/`record_update` are unchanged (their parameter really is `id`).

### Changed

- **`hybrid_search` results now carry `externalId` per hit, and the response
  includes `hasMore`.** `externalId` lets you correlate a hit back to your own
  record/document identity without a follow-up lookup (null if the item was
  ingested without one, or indexed before this field existed). `hasMore` tells
  you explicitly whether more results are available past the current page.
- **The `textLegEmpty` diagnostic no longer fires on every non-empty TEXT-mode
  search.** It's based on each hit's keyword-relevance score, which the API
  previously reported as `0` for every TEXT-mode result regardless of actual
  relevance; TEXT-mode now returns a real, meaningful score, so the diagnostic
  only fires when the keyword leg genuinely contributed nothing.
- **Dependency maintenance** — repinned the bundled `@vectros-ai/sdk` to `0.37.0`
  (additive `basedOn` schema customization, `specificityRank` on namespaces, and
  the search/RAG response fields above). The server bundles the SDK into its
  published output, so this is a rebuild against the current SDK.

## 0.11.0

Refreshed to the 0.36.0 Vectros API, with clearer, more actionable errors and a
few tool-surface corrections.

### Changed

- **Tool errors now carry the server's real reason, a typed code, and a request
  id.** When a tool call fails, the result surfaces the API's own message, the
  machine-readable `errorCode` (so an agent can branch on the cause — e.g.
  `INSUFFICIENT_BALANCE` "top up your balance" versus `SUBSCRIPTION_LIMIT_EXCEEDED`
  "upgrade your plan" on a payment-required failure, or a placement/authorization
  denial), and the `requestId` to quote to support — instead of a bare HTTP status
  and a generic class name.
- **`document_ingest` rejects `storeText` in text mode instead of ignoring it.**
  `storeText` only applies to file uploads (it controls whether a file's extracted
  text is retained). A text-ingested body is the document itself and is always
  retained, so passing `storeText` alongside `text` is now refused with a clear
  message rather than silently having no effect.

### Added

- **Errors surface the 0.36.0 typed error codes.** Payment-required failures on
  `rag_ask` / `document_ask` now distinguish an exhausted pre-paid balance from a
  reached plan limit; a number outside the signed 64-bit range is reported as a
  `400` naming the field.
- **Guidance for search-indexing failures.** `document_get` and `record_get`
  descriptions explain the `indexFailure.code` that accompanies a `FAILED`
  `indexStatus`, so an agent can tell content that is still partly findable
  (e.g. `VECTOR_LIMIT_EXCEEDED`, keyword search still serves it) from content that
  is not findable at all (`INDEXING_FAILED`).
- **Large-number guidance.** `record_create` and `document_ingest` note that every
  number must fall within the signed 64-bit range and that larger whole numbers
  (e.g. big external ids) should be sent as strings, which store exactly and support
  exact-match lookup.

### Fixed

- **`current_identity` / the `identity` resource describe the identity shape they
  actually return.** The obsolete "the backend is still rolling this out" caveat is
  gone; the extended shape (`principalType`, `principalKeyId`, `allowedActions`, and
  a `dataScope` of `{ userId, scopes[] }`) is returned today.
- **`hybrid_search` gives accurate keyword-leg guidance.** When the keyword leg
  matches nothing (`textLegEmpty`), the description now explains that the default
  phrase match found no contiguous hit for a long query and points to shortening the
  query or setting `textMode` to `AND` (precision) or `OR` (recall), rather than
  prescribing a single fix.
- **`record_create` and `folder_create` describe the scope needed to receive an
  existing item on a collision, not just to create one.** Both tools are
  idempotent by key (`externalId` for records, `slug` for folders); the
  description previously said only `records:c`/`folders:c` was required, but
  being handed back the existing item on a collision is a read of that item
  and separately requires `records:r`/`folders:r`. A key holding only the
  create scope now gets an accurate description of the "already exists"
  error it will see instead of the record.

## 0.10.0

### Changed (breaking)

- **Organization and client identities are now namespaces.** The tools that took
  `orgId` / `clientId` now use namespaced scopes:
  - `lookup_principal`: `kind` is `"user"` or a namespace (`org`, `client`, or
    one you define).
  - Write tools (`record_create`, `folder_create`, `folder_update`,
    `document_ingest`, `document_update`): the `orgId` / `clientId` inputs are
    replaced by `scopes` — an array of `namespace:value` entries, e.g.
    `["org:<id>"]`.
  - Read and query tools (`record_query`, `document_query`, `folder_query`,
    `hybrid_search`, `rag_ask`, `list_schemas`): the `orgId` / `clientId` filters
    are replaced by a single `scope` filter (`namespace:value`). `list_schemas`'s
    `surface` now accepts `record`, `document`, `user`, `entity`.

### Added

- **Automatic API-key resolution from the Vectros CLI keyring.** When
  `VECTROS_API_KEY` is not set, the server now resolves its key by invoking the
  `vectros` CLI credential helper (`vectros keyring show --format raw`) as a
  subprocess — so a key stored once in the CLI keyring is shared by the server, agent
  hooks, and scripts, instead of a plaintext copy pasted into the server's config
  that silently drifts. `VECTROS_API_KEY` still takes precedence when set (behavior
  unchanged), and an unset key now falls back to the keyring rather than failing
  immediately. Set `VECTROS_KEYRING_ALIAS` to resolve a specific keyring entry
  instead of the active one. Requires **`@vectros-ai/cli` 0.9.0+** on `PATH` (the
  version the keyring itself shipped in — the helper deliberately calls no command
  newer than that, so it works with an existing install); if neither an env key nor
  the CLI is available, startup fails with actionable guidance naming both options.
  The resolved key is held in memory only and never logged.
- **Startup says which identity it resolved, and warns when you didn't name one.**
  The startup log names the keyring entry the key came from (never the key itself).
  When `VECTROS_API_KEY` is unset and no `VECTROS_KEYRING_ALIAS` is given, the key
  comes from whichever entry was last made active — and that log is a **warning**,
  whatever key turns up: silently getting a live key (acting on real data) and
  silently getting a test key (not acting on it, when you believed you were) are both
  unwelcome. It is easy to reach by accident, because a blank placeholder
  (`"VECTROS_API_KEY": ""` in a client config, or a Docker `-e` pass-through of an
  unset var) reads as "not configured yet" but resolves like an unset key. Nothing is
  blocked, and naming an entry never warns.

## 0.9.0

### Added

- **Ownership scopes on writes.** `record_create`, `document_ingest`, and `folder_create`
  accept a `scopes` array of `namespace:value` entries (at most 2 — e.g.
  `["org:<uuid>", "group:eng-team"]`), declaring the item's complete scope ownership
  from the credential's own identity. An empty array (`[]`) creates a **private**,
  user-owned item — the building block for per-user agent memory alongside shared
  team content. Omit the field to keep today's behavior (the credential's full
  identity is stamped).
- **`scope` filter on reads and retrieval.** `record_query` and `document_query`
  (list mode), `hybrid_search`, and `rag_ask` retrieval accept a `scope` filter in the
  same `namespace:value` form, confining results — or a grounded answer's corpus — to
  one scope. `scope=org:<id>` / `scope=client:<id>` are equivalent to the existing
  `orgId`/`clientId` filters.

## 0.8.1 — 2026-07-10

### Changed

- **Dependency maintenance** — repinned the bundled `@vectros-ai/sdk` to `0.34.0`
  (additive `scopes` read-back on record/document/folder responses, plus webhooks).
  The server bundles the SDK into its published output, so this is a rebuild against
  the current SDK; no tool behavior changes.

## 0.8.0 — 2026-07-10

Larger result limits and real pagination across every enumeration tool — no tool
forces you to accept a hard ceiling you can't get past.

### Changed

- **Higher `limit` ceilings, up to each API's max.** Every enumeration tool keeps a low
  default (context protection) but now lets you raise `limit` in a single call when you
  can accept the larger payload: `record_query` and `document_query` max **10 → 100**;
  `hybrid_search` max **10 → 50**; `rag_ask`'s grounding-corpus limit max **10 → 50**;
  `lookup_principal` max **50 → 100**; `folder_query` max **50 → 100**. Heavy
  passages/payloads already auto-truncate, so a high limit is safe.
- **Pagination on every enumeration tool, with an explicit "more remains" signal.**
  - `record_query`, `document_query`, and `lookup_principal` now return a
    `{ data, nextCursor }` page and accept a `startFrom` cursor. **This is a shape change**
    — these tools previously returned a bare array. A non-null `nextCursor` means more
    results remain; pass it back as `startFrom` to page. (This matches `folder_query` and
    `version_history`, which already worked this way.)
  - `hybrid_search` keeps `offset` pagination and now adds an explicit `hasMore` flag
    (derived from `totalResults`) so you know when results remain past the current page.
- **Tool descriptions refreshed** to state the real max, that raising it is the agent's
  context-cost call, and how to page.

## 0.7.1 — 2026-07-09

### Changed

- **`rag_ask` model examples updated.** The `model` parameter description now lists
  `claude-sonnet-5`; the earlier `claude-sonnet-4-6` alias has been retired. Call
  `GET /v1/models` for the current inference catalog your key can reach.

## 0.7.0 — 2026-07-05

Text-retention control that works, and tool descriptions that tell the truth
about it.

### Added

- **`storeText` works in file mode on `document_ingest`.** The flag was advertised but silently
  dropped on file uploads; it now forwards your retention choice. Default `true` keeps the
  extracted text available to `document_get(includeText: true)` and `document_ask`; `false`
  discards it once indexing completes (search and the original-file download keep working).
  Fixed at ingest — a re-ingest of the same document keeps the original choice.

### Changed

- **`document_update` no longer accepts `storeText`** — retention is immutable after ingest, so
  the input was misleading (the server now rejects such updates).
- `document_ingest`, `document_get`, and `document_update` descriptions rewritten to the real
  retention semantics: text-mode bodies are always retained; text availability on
  `document_get` reflects whether the text actually exists.

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
