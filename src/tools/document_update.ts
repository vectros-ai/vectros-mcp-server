/**
 * document_update — update a document's metadata / typed payload. Wraps
 * `client.documents.patchDocument()` (RFC-7386 JSON Merge Patch).
 *
 * PATCH semantics (from the SDK contract):
 *   • `payload`, when supplied, is DEEP-MERGED into the stored payload (keys you
 *     send overwrite, a key set to `null` is deleted, omitted keys preserved) —
 *     no read-modify-write, no wipe trap.
 *   • Top-level fields (`title`, `folderId`, `storeText`, `status`, ownership) are
 *     set when present and left unchanged when omitted.
 *   • `indexMode`/`externalId` are immutable and rejected if present; `folderId`
 *     can be SET but not cleared.
 *
 * Optimistic concurrency: pass the `version` you last read as `expectedVersion`.
 * If the document changed since, the server rejects with a 409 conflict (re-read
 * via document_get and retry). Omit `expectedVersion` for last-write-wins.
 *
 * Requires the credential to allow `documents:u`.
 */
import { z } from 'zod';
import type { Vectros } from '@vectros-ai/sdk';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';
import { resolveDocumentIdByExternalId } from './resolve-external-id.js';

const inputSchema = {
  documentId: z
    .string()
    .optional()
    .describe('The Vectros document id to update. Provide this OR externalId+type.'),
  externalId: z
    .string()
    .optional()
    .describe(
      'Your caller-owned externalId — an alternative selector to `documentId` (requires `type`). Updates the ' +
        'document you ingested under that externalId without a manual lookup first.',
    ),
  type: z
    .string()
    .optional()
    .describe('Document type — REQUIRED when selecting by `externalId` (externalId is unique within a type).'),
  title: z.string().optional().describe('New title. Omit to keep the current title.'),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Typed-payload field→value changes DEEP-MERGED into the existing payload (a field set to `null` is ' +
        'deleted; unspecified fields preserved). Omit to leave the payload unchanged.',
    ),
  text: z
    .string()
    .optional()
    .describe(
      'New raw text body. Supplying it re-ingests the document body and re-queues it for indexing, so the ' +
        'search index reflects the edit (text-ingested documents only — not file-backed ones). Omit to leave ' +
        'the stored text unchanged. This is the in-place alternative to re-ingesting with upsert:true.',
    ),
  folderId: z.string().optional().describe('Move the document into this folder (cannot be cleared once set).'),
  storeText: z.boolean().optional().describe('Whether the raw text is stored + retrievable.'),
  status: z
    .enum(['ACTIVE', 'ARCHIVED'])
    .optional()
    .describe(
      'Lifecycle status. `ARCHIVED` soft-retracts the document — it is pulled from search and recall but ' +
        'kept and recoverable; set it back to `ACTIVE` to re-index and restore it. The way to retire ' +
        'superseded content when the credential has no delete authority. Omit to leave unchanged.',
    ),
  userId: z.string().optional().describe('Reassign the owning user (Vectros UUID).'),
  orgId: z.string().optional().describe('Reassign the owning org (Vectros UUID).'),
  clientId: z.string().optional().describe('Reassign the associated client (Vectros UUID).'),
  expectedVersion: z
    .number()
    .int()
    .optional()
    .describe(
      'Optimistic concurrency: the version you last read. If the document changed since, the update is ' +
        'refused as a conflict (re-read and retry). Omit for last-write-wins.',
    ),
};

const documentUpdate: ToolFactory = ({ client, log }) => ({
  name: 'document_update',
  title: 'Update a document',
  description:
    'Update a document — select it by its Vectros `documentId` OR by your own `externalId` + `type` ' +
    '(resolved for you). `fields` are DEEP-MERGED into the existing typed payload (unspecified fields ' +
    'preserved; a field set to `null` is deleted); title/folderId/status/ownership are updated when provided ' +
    'and preserved otherwise. Supply `text` to re-ingest and re-index the document body in place (text ' +
    'documents only). Set `status: "ARCHIVED"` to soft-retract a document (pulled from search, kept and ' +
    'recoverable) and `status: "ACTIVE"` to restore it. Pass `expectedVersion` (the version you last read) ' +
    'for safe concurrent edits — a stale update is refused (409). Requires the key to allow documents:u.',
  inputSchema,
  handler: async (args): Promise<ToolResult> => {
    const documentId = args.documentId as string | undefined;
    const externalId = args.externalId as string | undefined;
    const type = args.type as string | undefined;
    const title = args.title as string | undefined;
    const fields = args.fields as Record<string, unknown> | undefined;
    const text = args.text as string | undefined;
    const folderId = args.folderId as string | undefined;
    const storeText = args.storeText as boolean | undefined;
    const status = args.status as Vectros.DocumentRequest.Status | undefined;
    const userId = args.userId as string | undefined;
    const orgId = args.orgId as string | undefined;
    const clientId = args.clientId as string | undefined;
    const expectedVersion = args.expectedVersion as number | undefined;
    try {
      const resolved = await resolveDocumentIdByExternalId(client, { id: documentId, externalId, type });
      if ('error' in resolved) return toolError('document_update', new Error(resolved.error));
      // RFC-7386 merge-patch: send only what's changing. The server preserves
      // omitted top-level fields and deep-merges `payload`, so no read-modify-write
      // and no title-carry-forward is needed. `title` is omitted when the caller
      // isn't changing it; the shared DocumentRequest type marks it required (it is
      // for PUT), so the patch body is assembled untyped and cast at the call.
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (fields !== undefined) body.payload = fields;
      if (text !== undefined) body.text = text;
      if (folderId !== undefined) body.folderId = folderId;
      if (storeText !== undefined) body.storeText = storeText;
      if (status !== undefined) body.status = status;
      if (userId !== undefined) body.userId = userId;
      if (orgId !== undefined) body.orgId = orgId;
      if (clientId !== undefined) body.clientId = clientId;
      if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;

      const updated = await client.documents.patchDocument({
        id: resolved.id,
        body: body as Vectros.DocumentRequest,
      });
      log.debug({ tool: 'document_update', documentId: resolved.id, externalId }, 'document_update ok');
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'document_update', documentId, err: String(err) }, 'document_update failed');
      return toolError('document_update', err);
    }
  },
});

export default documentUpdate;
