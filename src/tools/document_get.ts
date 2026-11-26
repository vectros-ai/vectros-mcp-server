/**
 * document_get — wraps `client.documents.getDocument({id})` plus
 * (optionally) `client.documents.getDocumentText({id})` and/or
 * `client.documents.getDocumentDownloadUrl({id})`.
 *
 * Returns document metadata, optionally with full text inline and/or a
 * presigned download URL for the file.
 *
 * MCP-specific text truncation: when `includeText: true`, the text
 * is capped at ~8,000 tokens (≈ 32,000 chars at the standard
 * 4-chars-per-token English heuristic). Caps the agent's context
 * burn from a single tool call and forces the agent toward
 * `document_ask` for question-driven extraction on large documents.
 * Truncation surfaces as `truncated: true` in the response.
 *
 * `getDocumentText` returns 404 when the document was ingested
 * whose text is not retained. We handle this gracefully — surface
 * `textAvailable: false` in the response so the agent knows
 * `document_ask` is the right next step instead of returning isError.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { resolveDocumentIdByExternalId } from './resolve-external-id.js';

// ~8K tokens at 4 chars/token (rough English heuristic). Conservative
// — better to truncate slightly early than to blow past an agent's
// context window mid-tool-call.
const MAX_TEXT_CHARS = 32_000;

const inputSchema = {
  documentId: z
    .string()
    .optional()
    .describe('The document ID returned by document_ingest or hybrid_search. Provide this OR externalId+type.'),
  externalId: z
    .string()
    .optional()
    .describe(
      'Your caller-owned externalId — an alternative selector to `documentId` (requires `type`). Fetches the ' +
        'document you ingested under that externalId without a manual lookup first.',
    ),
  type: z
    .string()
    .optional()
    .describe('Document type — REQUIRED when selecting by `externalId` (externalId is unique within a type).'),
  includeText: z
    .boolean()
    .optional()
    .describe(
      'If true, fetch and include the document text (capped at ~8K tokens, truncated: true flag if cut). ' +
        'Default false — metadata only. For larger documents, prefer `document_ask` over dumping text into context.',
    ),
  includeDownloadUrl: z
    .boolean()
    .optional()
    .describe(
      'If true, also return a short-lived presigned `downloadUrl` for the file (file-backed documents ' +
        'only — the way to retrieve the raw bytes of a document ingested via file mode). Default false. ' +
        'Unavailable for text-only documents, and for an image that was rejected, is still being processed or was taken down — ' +
        '`downloadAvailable: false` is set instead. `downloadExpires` is ' +
        'an upper bound, not a guarantee: if the file behind this document is replaced (a document_ingest ' +
        'upsert) after this URL is minted, the URL can stop working before that time. Request a fresh one after ' +
        'any re-ingest rather than reusing one you already hold.',
    ),
};

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

/**
 * Is this a "the document has no retrievable file/text" response rather than a
 * real error? getDocumentText 404s when the text was not retained (file uploads
 * with storeText:false discard it after indexing); a download URL is 404/400 for
 * a text-only (non-file) document. Both mean "not available for this document",
 * which we surface as a flag rather than isError.
 */
function isNotAvailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { statusCode?: number };
  return e.statusCode === 404 || e.statusCode === 400;
}

/**
 * The text read's own "not available" cases: the two above, and a document of a public-media type, which holds an image and
 * no text (the platform answers `409` with `errorCode` `NO_TEXT_FOR_MEDIA`). Any other 409 is a real error.
 */
function isTextNotAvailable(err: unknown): boolean {
  return isNotAvailable(err) || isMediaRefusal(err, 'NO_TEXT_FOR_MEDIA');
}

/**
 * The download's own "not available" cases: the two above, and an image (a public-media document) with no private copy to give: rejected,
 * still processing or taken down (the platform answers `409` with `errorCode` `NO_DOWNLOAD_FOR_MEDIA`). Any other 409 is a real error.
 */
function isDownloadNotAvailable(err: unknown): boolean {
  return isNotAvailable(err) || isMediaRefusal(err, 'NO_DOWNLOAD_FOR_MEDIA');
}

function isMediaRefusal(err: unknown, errorCode: string): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { statusCode?: number; body?: unknown };
  const body = e.body && typeof e.body === 'object' ? (e.body as { errorCode?: unknown }) : undefined;
  return e.statusCode === 409 && body?.errorCode === errorCode;
}

const documentGet: ToolFactory = ({ client, log }) => ({
  name: 'document_get',
  title: 'Get document metadata (and optionally text)',
  description:
    'Fetch metadata for a single document — select it by its Vectros `documentId` OR by your own ' +
    '`externalId` + `type` (resolved for you). Pass `includeText: true` to also fetch the text body ' +
    '(capped at ~8K tokens; `truncated: true` flag if cut). Text is available for every text-ingested ' +
    'document and for file-ingested documents unless they were uploaded with `storeText: false` (extracted ' +
    'text discarded after indexing) or no text could be extracted from the file (`extraction.outcome` other ' +
    'than OK/TRUNCATED, e.g. a scanned page, or NOT_EXTRACTED for audio, video, an image or an archive), and never for a document of a public-media type (an image) — then `textAvailable: false` is set; for a file-backed document the file can be fetched with `includeDownloadUrl` (for an image, a private copy of the processed image). ' +
    'Pass `includeDownloadUrl: true` to also ' +
    'get a short-lived presigned `downloadUrl` for the file (file-backed documents only). ' +
    'Returns the full document metadata, including its lifecycle `status` (ACTIVE, or ARCHIVED when ' +
    'soft-retracted from search — restorable via document_update) and its processing `indexStatus`. When ' +
    '`indexStatus` is FAILED the response also carries `indexFailure` with a machine-readable `code` telling ' +
    'you whether the content is still findable — e.g. TEXT_INDEX_FAILED / VECTOR_LIMIT_EXCEEDED (one leg ' +
    'still serves it) vs INDEXING_FAILED (not findable by search at all). Branch on `code`, not on the message.' +
    ' An `INDEXED` item can also carry `indexFailure` with code LOCATION_NOT_INDEXED: a value in one of its `geo` fields is not a valid point, so it was indexed without that location and a location search does not find it.',
  inputSchema,
  // A pure read — never creates, modifies, or deletes anything server-side.
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (args): Promise<ToolResult> => {
    const documentId = args.documentId as string | undefined;
    const externalId = args.externalId as string | undefined;
    const type = args.type as string | undefined;
    const includeText = (args.includeText as boolean | undefined) ?? false;
    const includeDownloadUrl = (args.includeDownloadUrl as boolean | undefined) ?? false;

    try {
      const resolved = await resolveDocumentIdByExternalId(client, { id: documentId, externalId, type });
      if ('error' in resolved) return toolError('document_get', new Error(resolved.error));
      const id = resolved.id;
      const doc = await client.documents.getDocument({ id });

      let extra: Record<string, unknown> = {};

      if (includeText) {
        // Second call — swallow "no text" gracefully (not retained, none could be extracted, or a public-media document).
        try {
          const textResponse = await client.documents.getDocumentText({ id });
          const rawText = textResponse?.text ?? '';
          const { text, truncated } = truncateText(rawText);
          extra = { ...extra, text, truncated, textAvailable: true };
        } catch (textErr) {
          if (isTextNotAvailable(textErr)) {
            log.debug(
              { tool: 'document_get', id },
              'document_get text unavailable (not retained, no text could be extracted from the file, or a public-media document)',
            );
            extra = { ...extra, textAvailable: false };
          } else {
            throw textErr; // a real error — surface it
          }
        }
      }

      if (includeDownloadUrl) {
        // Presigned file URL — 404/400 for a text-only document (no backing file).
        try {
          const dl = await client.documents.getDocumentDownloadUrl({ id });
          extra = {
            ...extra,
            downloadUrl: dl?.downloadUrl,
            downloadExpires: dl?.expires,
            downloadFileType: dl?.fileType,
            downloadAvailable: true,
          };
        } catch (dlErr) {
          if (isDownloadNotAvailable(dlErr)) {
            log.debug({ tool: 'document_get', id }, 'document_get download unavailable (not a file document, or an image)');
            extra = { ...extra, downloadAvailable: false };
          } else {
            throw dlErr; // a real error — surface it
          }
        }
      }

      log.debug({ tool: 'document_get', id, includeText, includeDownloadUrl }, 'document_get ok');
      return {
        content: [
          { type: 'text', text: JSON.stringify(includeText || includeDownloadUrl ? { ...doc, ...extra } : doc, null, 2) },
        ],
      };
    } catch (err) {
      log.warn({ tool: 'document_get', documentId, externalId, type, err: String(err) }, 'document_get failed');
      return toolError('document_get', err);
    }
  },
});

export default documentGet;
