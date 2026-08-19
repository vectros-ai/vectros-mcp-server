/**
 * document_ingest — dual-mode document creation.
 *
 * Wraps `client.documents.ingestDocument()` (inline text body) OR
 * `client.documents.uploadDocument()` (file upload via presigned URL).
 * Mode auto-selected from args:
 *   - `text` present  → inline ingest (single SDK call)
 *   - `filePath` present → upload flow (3 steps: uploadDocument()
 *                          for presigned URL → PUT bytes → return)
 *
 * Either `text` or `filePath` MUST be present; both is an error.
 *
 * **Transport asymmetry (locked v0.2 design — see
 * the design doc § Documents → document_ingest):**
 *
 *   stdio transport:
 *     - `text`     → ingestDocument()
 *     - `filePath` → read local fs, uploadDocument(), PUT bytes
 *
 *   HTTP transport:
 *     - `text`     → ingestDocument() (same as stdio)
 *     - `filePath` → REJECTED at validation time. Remote MCP servers
 *                    can't read the partner's filesystem. Partner
 *                    must use text mode or call SDK directly.
 *
 * The rejection on HTTP+filePath is intentional and load-bearing —
 * silently failing-or-succeeding-weirdly would be worse than a
 * clear error message pointing to the workaround.
 */
import { z } from 'zod';
import { readFile, realpath } from 'node:fs/promises';
import { basename, extname, resolve, relative, isAbsolute } from 'node:path';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

/** Thrown when a filePath escapes the ingest jail. */
class IngestPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestPathError';
  }
}

/**
 * Path segments that are never ingestable, even when they sit inside the
 * configured root (defense-in-depth on top of the jail). Lower-cased.
 */
const DENIED_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
]);
/** Sensitive basenames denied regardless of directory. Lower-cased. */
const DENIED_BASENAMES = new Set([
  '.env',
  'credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.npmrc',
  '.netrc',
  '.pgpass',
]);

/**
 * Canonicalize `filePath` and confine it to `ingestRoot`. Returns the
 * canonical (symlink-resolved) absolute path on success; throws
 * {@link IngestPathError} on a traversal / absolute / symlink escape, a path
 * outside the root, a non-existent file, or a denied sensitive path.
 *
 * The model supplies `filePath`; a prompt-injection adversary would otherwise
 * read `~/.aws/credentials` / `~/.ssh/id_rsa` and exfiltrate it as a document.
 *
 * Threat model: the confused deputy is the AGENT (model authority) vs the
 * OPERATOR's secrets, with server + agent running as the same OS user. A
 * realpath→readFile TOCTOU (a separate local process swapping the file
 * mid-call) is out of scope — an attacker with write access inside the ingest
 * root already shares the operator's trust boundary.
 */
async function resolveJailedPath(filePath: string, ingestRoot: string): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(ingestRoot));
  } catch {
    throw new IngestPathError(
      `the document ingest root "${ingestRoot}" does not exist or is not accessible. ` +
        `Set VECTROS_MCP_INGEST_ROOT to a readable directory.`,
    );
  }

  // resolve() lets an ABSOLUTE filePath override the root entirely — that is
  // caught by the containment check below (the canonical path won't be inside
  // the root). realpath() resolves symlinks, defeating in-root symlink escapes.
  const requested = resolve(canonicalRoot, filePath);
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    throw new IngestPathError(
      `Cannot read filePath "${filePath}": no such file under the ingest root "${canonicalRoot}".`,
    );
  }

  const rel = relative(canonicalRoot, canonical);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new IngestPathError(
      `filePath "${filePath}" resolves outside the allowed ingest root "${canonicalRoot}". ` +
        `Set VECTROS_MCP_INGEST_ROOT to permit a different directory.`,
    );
  }

  const lowerSegs = canonical.toLowerCase().split(/[\\/]+/);
  if (lowerSegs.some((s) => DENIED_SEGMENTS.has(s)) || DENIED_BASENAMES.has(basename(canonical).toLowerCase())) {
    throw new IngestPathError(
      `filePath "${filePath}" matches a denied sensitive-path pattern and cannot be ingested.`,
    );
  }

  return canonical;
}

// Minimal MIME-type lookup for common file types. Partners can
// explicitly pass fileType to override.
const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.rtf': 'application/rtf',
};

function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

const inputSchema = {
  title: z
    .string()
    .min(1, 'title is required')
    .describe('Human-readable document title — appears in search results and the UI.'),
  indexMode: z
    .enum(['HYBRID', 'SEMANTIC', 'TEXT', 'NONE'])
    .optional()
    .describe(
      'Index strategy. HYBRID (BM25 + dense, default; best for general retrieval), ' +
        'SEMANTIC (dense only; concept-driven queries), TEXT (BM25 only; exact-match / keyword), ' +
        'NONE (store-only / archival — retrievable by id and structured-field lookup but never in search results). ' +
        'Omit to inherit the bound schema\'s default.',
    ),
  externalId: z
    .string()
    .optional()
    .describe(
      'Stable caller-supplied id. Immutable; unique per type within your context. Re-ingesting with the same ' +
        'externalId returns the existing document (idempotent) instead of creating a duplicate — use it to make ' +
        'ingests safely retryable and as the key other records reference. Mirrors record_create. Receiving the ' +
        'existing document back is a read of it and needs documents:r in addition to documents:c; a create-only ' +
        'key gets an "already exists" error instead of the document.',
    ),
  upsert: z
    .boolean()
    .optional()
    .describe(
      'When true, re-ingesting an existing externalId OVERWRITES that document and re-indexes the new body ' +
        '(text mode) / re-uploads and re-indexes the new file (file mode), instead of returning the existing ' +
        'one unchanged. This is the curation/re-sync primitive: edit a source, re-ingest with upsert:true, and ' +
        'the search index reflects the new content. Requires the documents:u scope. IMPORTANT: pass the SAME ' +
        'schemaId (and type) you used originally — externalId is unique WITHIN a type, so omitting schemaId ' +
        'resolves in the untyped namespace and mints a duplicate instead of updating. The response `created` ' +
        'flag confirms which happened (created:true = a new document was minted).',
    ),
  schemaId: z
    .string()
    .optional()
    .describe(
      'Bind this document to a record schema. When set, `payload` is validated against the schema and its ' +
        'lookup fields become directly queryable via document_query (records parity). Resolve a schema id from ' +
        'its type via list_schemas. Omit for an untyped document.',
    ),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'The document\'s structured data — a flat key/value object. With `schemaId`, declared fields are validated ' +
        'and lookup fields indexed; undeclared keys pass through as free-form and are searchable via the ' +
        'hybrid_search `filters` param. Without a schema it is stored as free-form metadata. Every number must ' +
        'fall within the signed 64-bit range — send a larger whole number as a STRING (stored exactly, ' +
        'exact-match lookup), else the ingest is refused with a 400 naming the field.',
    ),

  // Inline text mode (mutually exclusive with filePath):
  text: z
    .string()
    .min(1)
    .optional()
    .describe('Text body to ingest inline. Mutually exclusive with filePath. Either text or filePath is required.'),
  storeText: z
    .boolean()
    .optional()
    .describe(
      'FILE MODE ONLY. Whether the uploaded file\'s EXTRACTED text is retained after indexing (default ' +
        'true), fixed at ingest. true keeps the extracted text retrievable via document_get(includeText:true) ' +
        'and usable by document_ask; false discards it once indexing completes — search still works and the ' +
        'original file remains downloadable, but includeText returns textAvailable:false and document_ask is ' +
        'unavailable. NOT accepted with `text`: a text-ingested body is the document itself and is ALWAYS ' +
        'retained, so the backend has no storeText knob on the text path — passing it with `text` is rejected ' +
        'rather than silently ignored.',
    ),

  // File upload mode (mutually exclusive with text; stdio-transport-only):
  filePath: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Local filesystem path to upload. Mutually exclusive with text. ' +
        'STDIO TRANSPORT ONLY — rejected on HTTP transport (remote MCP servers can\'t read your filesystem; ' +
        'use text mode or call the SDK\'s uploadDocument directly). ' +
        'Must resolve INSIDE the configured ingest root (VECTROS_MCP_INGEST_ROOT, else the server\'s working ' +
        'directory); paths that escape it (traversal/absolute/symlink) or match a sensitive pattern are rejected.',
    ),
  fileType: z
    .string()
    .optional()
    .describe('MIME type of the file (e.g. "application/pdf"). Inferred from filePath extension if omitted.'),

  // Common (both modes):
  folderId: z
    .string()
    .optional()
    .describe('Optional folder to ingest into. Default: tenant root.'),
  userId: z.string().optional().describe('Owning user ID. Optional.'),
  scopes: z
    .array(z.string())
    .optional()
    .describe(
      'TEXT MODE ONLY. Scope ownership as `namespace:value` entries, at most 2 (e.g. ["org:<uuid>", ' +
        '"group:eng-team"]). `org` and `client` are reserved namespace names, registered like any ' +
        'other; others are namespaces you registered yourself. This is the document\'s COMPLETE scope declaration and values must come from the ' +
        'credential\'s own identity. An empty array `[]` creates a PRIVATE document owned by the calling ' +
        'user alone. Omit to stamp the credential\'s full identity — the default. Rejected with `filePath` ' +
        '(file uploads do not accept a scope declaration): a file-uploaded document is stamped with the ' +
        'credential\'s full identity.',
    ),
};

const documentIngest: ToolFactory = ({ client, log, transport, ingestRoot }) => ({
  name: 'document_ingest',
  title: 'Ingest a new document (text body or file upload)',
  description:
    'Create a new document in your Vectros tenant. Two modes:\n' +
    '  • Text mode: pass `text` (string body). Single-call. Use for crawled content, notes, generated text.\n' +
    '  • File mode: pass `filePath` (local path on the MCP server\'s host machine). STDIO-TRANSPORT ONLY — ' +
    'rejected on HTTP transport. MCP server reads the bytes, requests a presigned upload URL, and PUTs them. ' +
    'Returns when the upload is accepted (indexStatus: PENDING_INDEX); poll with `document_get` until indexStatus is INDEXED.\n' +
    'Either `text` or `filePath` must be present; both is an error. ' +
    'Idempotent by `externalId` (re-ingest returns the existing document, not a duplicate — requires ' +
    'documents:r in addition to documents:c, since being handed the existing document is a read of it). To UPDATE an ' +
    'existing document instead — re-index an edited body — pass `upsert:true` with the same `externalId` ' +
    '(and the same `schemaId`); this is the re-sync primitive for keeping a knowledge base current. Pass ' +
    '`schemaId` + `payload` for a typed, lookup-queryable document (records parity). ' +
    'indexMode defaults to HYBRID for untyped documents (omit to inherit a bound schema\'s default). ' +
    'storeText is a FILE-MODE knob (default true): false discards the uploaded file\'s extracted text ' +
    'after indexing (search + file download keep working; text retrieval and document_ask do not). ' +
    'Text-mode bodies are always retained, so storeText is not accepted with `text`.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const title = args.title as string;
    const text = args.text as string | undefined;
    const filePath = args.filePath as string | undefined;
    const schemaId = args.schemaId as string | undefined;
    const upsert = args.upsert as boolean | undefined;
    // Preserve the legacy default (HYBRID) for untyped documents; when a schema is
    // bound, omit indexMode so the schema's declared default is inherited (the API
    // rejects a request with neither). An explicit value — including NONE — always wins.
    const indexMode =
      (args.indexMode as 'HYBRID' | 'SEMANTIC' | 'TEXT' | 'NONE' | undefined) ??
      (schemaId ? undefined : 'HYBRID');

    // Mode validation — exactly one of text/filePath.
    if (!text && !filePath) {
      return toolError(
        'document_ingest',
        new Error('Either `text` (inline body) or `filePath` (local file) is required.'),
      );
    }
    if (text && filePath) {
      return toolError(
        'document_ingest',
        new Error('`text` and `filePath` are mutually exclusive — pass exactly one.'),
      );
    }

    // Transport gate — HTTP transport rejects filePath.
    if (filePath && transport === 'http') {
      return toolError(
        'document_ingest',
        new Error(
          'filePath mode is not supported on HTTP transport. The remote MCP server cannot read your local filesystem. ' +
            'Use `text` mode (pass the content inline) or call the @vectros-ai/sdk uploadDocument method directly from your own code.',
        ),
      );
    }

    // Scope gate — the file-upload init endpoint does not accept a `scopes`
    // declaration, so passing it through would be SILENTLY DROPPED and the
    // document stamped with the credential's full identity. For `scopes: []`
    // (a private document) that would be a silent tier ESCALATION —
    // intended-private content becoming org/team-visible. Fail loud instead.
    if (filePath && args.scopes !== undefined) {
      return toolError(
        'document_ingest',
        new Error(
          '`scopes` is not supported with `filePath` — file uploads do not accept a scope declaration, and ' +
            'silently ignoring it could make an intended-private document team-visible. Use `text` mode to ' +
            'declare scopes, or omit `scopes` (the upload is stamped with the credential\'s full identity).',
        ),
      );
    }

    // storeText gate — the flag is a FILE-mode retention knob for the uploaded
    // file's EXTRACTED text. The inline-text path has no storeText field at all
    // (a text body is ALWAYS retained), so forwarding it there does nothing.
    // Rejecting a passed value on the text path makes the surface honest instead
    // of accepting-and-silently-ignoring it — a caller who passes storeText:false
    // on a text doc expecting a discard the text contract can never honor would
    // otherwise be silently misled.
    if (text && args.storeText !== undefined) {
      return toolError(
        'document_ingest',
        new Error(
          '`storeText` is not supported with `text` — a text-ingested body is the document itself and is ' +
            'always retained; the text path has no storeText control. Omit it (text mode), or use `filePath` ' +
            'mode where storeText:false discards the uploaded file\'s extracted text after indexing.',
        ),
      );
    }

    const common = {
      folderId: args.folderId as string | undefined,
      payload: args.payload as Record<string, unknown> | undefined,
      schemaId,
      externalId: args.externalId as string | undefined,
      userId: args.userId as string | undefined,
    };

    try {
      // ── Text mode ────────────────────────────────────────────────
      // A text-ingested body is the document itself and is always retained —
      // storeText is not part of the text contract (it is a file-upload knob),
      // so it is not forwarded here even if the caller supplied it.
      if (text) {
        const result = await client.documents.ingestDocument({
          upsert,
          body: {
            title,
            text,
            indexMode,
            // Scope ownership is a TEXT-mode contract only (the upload-init
            // endpoint has no scopes field — see the gate above).
            scopes: args.scopes as string[] | undefined,
            ...common,
          },
        });
        log.debug(
          { tool: 'document_ingest', mode: 'text', id: result?.id, indexMode },
          'document_ingest text ok',
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // ── File mode (stdio transport) ──────────────────────────────
      // 3-step flow per recon: uploadDocument → PUT bytes → return.
      // Caller can poll with document_get to confirm INDEXED.
      //
      // SECURITY: the path is model-supplied; jail it to the configured
      // ingest root (VECTROS_MCP_INGEST_ROOT, else the process cwd) and reject
      // traversal / absolute / symlink escapes BEFORE reading any bytes.
      const root = ingestRoot ?? process.env.VECTROS_MCP_INGEST_ROOT ?? process.cwd();
      let safePath: string;
      try {
        safePath = await resolveJailedPath(filePath!, root);
      } catch (err) {
        return toolError('document_ingest', err instanceof Error ? err : new Error(String(err)));
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(safePath);
      } catch (err) {
        // Friendlier error than the default fs.readFile message.
        const msg = err instanceof Error ? err.message : String(err);
        return toolError(
          'document_ingest',
          new Error(`Cannot read filePath: ${msg}. Verify the path exists on the MCP server's host machine.`),
        );
      }

      const fileName = basename(safePath);
      const fileType = (args.fileType as string | undefined) ?? inferMimeType(safePath);

      // storeText forwards the caller's retention choice to the file path (default
      // true — retain the extracted text; false discards it once indexing completes).
      const storeTextFile = (args.storeText as boolean | undefined) ?? true;
      const upload = await client.documents.uploadDocument({
        upsert,
        fileName,
        fileType,
        indexMode,
        storeText: storeTextFile,
        ...common,
      });

      const uploadUrl = upload?.uploadUrl as string | undefined;
      const docId = upload?.id as string | undefined;
      if (!uploadUrl || !docId) {
        return toolError(
          'document_ingest',
          new Error(`Unexpected uploadDocument response: missing uploadUrl or id. Got: ${JSON.stringify(upload)}`),
        );
      }

      // PUT bytes to presigned URL. No Authorization header (the URL
      // carries its own signature via query params).
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': fileType },
        body: bytes,
      });

      if (!putRes.ok) {
        const detail = await putRes.text().catch(() => '');
        return toolError(
          'document_ingest',
          new Error(
            `Presigned PUT failed (HTTP ${putRes.status}): ${detail || putRes.statusText}. ` +
              'The document record was created but the file upload did not complete; the document is in an incomplete state.',
          ),
        );
      }

      log.debug(
        { tool: 'document_ingest', mode: 'file', id: docId, fileName, fileType, bytes: bytes.length },
        'document_ingest file ok',
      );

      // Return the upload response — caller can poll document_get(id)
      // until indexStatus is INDEXED. We don't poll here; that's the agent's
      // job. The server stamped indexStatus before our PUT completed, so
      // override it with the post-upload processing state (the lifecycle
      // `status` passes through untouched — it's a separate axis).
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...upload,
                indexStatus: 'PENDING_INDEX',
                _note:
                  'File uploaded; indexing is asynchronous. Poll document_get(id) until indexStatus is INDEXED.',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      log.warn({ tool: 'document_ingest', err: String(err) }, 'document_ingest failed');
      return toolError('document_ingest', err);
    }
  },
});

export default documentIngest;
