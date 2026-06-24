/**
 * document_get — wraps `client.documents.getDocument({id})` plus
 * (optionally) `client.documents.getDocumentText({id})` and/or
 * `client.documents.getDocumentDownloadUrl({id})`.
 *
 * Returns document metadata, optionally with full text inline and/or a
 * presigned download URL for the original file.
 *
 * MCP-specific text truncation: when `includeText: true`, the text
 * is capped at ~8,000 tokens (≈ 32,000 chars at the standard
 * 4-chars-per-token English heuristic). Caps the agent's context
 * burn from a single tool call and forces the agent toward
 * `document_ask` for question-driven extraction on large documents.
 * Truncation surfaces as `truncated: true` in the response.
 *
 * `getDocumentText` returns 404 when the document was ingested
 * without `storeText: true`. We handle this gracefully — surface
 * `textAvailable: false` in the response so the agent knows
 * `document_ask` is the right next step instead of returning isError.
 *
 * See the design doc § Documents → document_get.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

// ~8K tokens at 4 chars/token (rough English heuristic). Conservative
// — better to truncate slightly early than to blow past an agent's
// context window mid-tool-call.
const MAX_TEXT_CHARS = 32_000;

const inputSchema = {
  documentId: z
    .string()
    .min(1, 'documentId is required')
    .describe('The document ID returned by document_ingest or hybrid_search.'),
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
      'If true, also return a short-lived presigned `downloadUrl` for the original file (file-backed documents ' +
        'only — the way to retrieve the raw bytes of a document ingested via file mode). Default false. ' +
        'Unavailable for text-only documents — `downloadAvailable: false` is set instead.',
    ),
};

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

/**
 * Is this a "the document has no retrievable file/text" response rather than a
 * real error? getDocumentText 404s when ingested without storeText; a download
 * URL is 404/400 for a text-only (non-file) document. Both mean "not available
 * for this document", which we surface as a flag rather than isError.
 */
function isNotAvailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { statusCode?: number };
  return e.statusCode === 404 || e.statusCode === 400;
}

const documentGet: ToolFactory = ({ client, log }) => ({
  name: 'document_get',
  title: 'Get document metadata (and optionally text)',
  description:
    'Fetch metadata for a single document by id. Pass `includeText: true` to also fetch the text body ' +
    '(capped at ~8K tokens; `truncated: true` flag if cut). If the document was ingested without ' +
    '`storeText: true`, text is unavailable — `textAvailable: false` flag is set and the agent should ' +
    'use `document_ask` for question-driven extraction instead. Pass `includeDownloadUrl: true` to also ' +
    'get a short-lived presigned `downloadUrl` for the original file (file-backed documents only). ' +
    'Returns full DocumentResponse from the SDK.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const id = args.documentId as string;
    const includeText = (args.includeText as boolean | undefined) ?? false;
    const includeDownloadUrl = (args.includeDownloadUrl as boolean | undefined) ?? false;

    try {
      const doc = await client.documents.getDocument({ id });

      let extra: Record<string, unknown> = {};

      if (includeText) {
        // Second call — swallow 404 gracefully (ingested without storeText).
        try {
          const textResponse = await client.documents.getDocumentText({ id });
          const rawText = textResponse?.text ?? '';
          const { text, truncated } = truncateText(rawText);
          extra = { ...extra, text, truncated, textAvailable: true };
        } catch (textErr) {
          if (isNotAvailable(textErr)) {
            log.debug(
              { tool: 'document_get', id },
              'document_get text unavailable (ingested without storeText)',
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
          if (isNotAvailable(dlErr)) {
            log.debug({ tool: 'document_get', id }, 'document_get download unavailable (not a file document)');
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
      log.warn({ tool: 'document_get', id, err: String(err) }, 'document_get failed');
      return toolError('document_get', err);
    }
  },
});

export default documentGet;
