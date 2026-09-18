/**
 * folder_create — create a folder. Wraps `client.folders.createFolder()`.
 *
 * Idempotent by `slug` within (tenant, context, parent) — ONLY when the caller
 * supplies `slug` explicitly. Omitting it is NOT a safe default: the platform
 * derives a slug via a collision-probing suffix loop (`intake-2026`,
 * `intake-2026-2`, …) that returns only a slug it has proved is free, so the
 * idempotency check that runs after derivation can never match on that path.
 * A redelivered `folder_create({name:'Intake 2026'})` with no `slug` silently
 * creates a new sibling folder every time. Pass a deterministic `slug` for any
 * call that must be safe under retry/redelivery. `parentId` places the folder
 * under a parent (create-only — a folder cannot be moved later via the API).
 *
 * Requires the credential to allow `folders:c` to create. Being returned an
 * existing folder on a collision additionally requires `folders:r` — a
 * `folders:c`-only key gets a clean "already exists" error instead of the
 * folder.
 */
import { z } from 'zod';
import type { ToolFactory, ToolResult } from './types.js';
import { toolError } from './errors.js';

const inputSchema = {
  name: z.string().min(1, 'name is required').describe('Folder display name.'),
  description: z.string().optional().describe('Optional description of the folder\'s purpose.'),
  parentId: z
    .string()
    .optional()
    .describe('Parent folder id — places the folder under this parent. Omit for the context default root. Create-only.'),
  slug: z
    .string()
    .optional()
    .describe(
      'Optional stable slug (sibling-unique; idempotency key). Lowercase letters/digits/hyphens. ' +
        'SUPPLY THIS to make a retry safe — if omitted, a derived slug is only ever a freshly-proved-free ' +
        'one, so a redelivered call creates a new sibling folder every time rather than matching the first.',
    ),
  userId: z.string().optional().describe('Owning user (Vectros UUID).'),
  scopes: z
    .array(z.string())
    .optional()
    .describe(
      'Scope ownership as `namespace:value` entries, at most 2 (e.g. ["org:<uuid>", "group:eng-team"]). ' +
        '`org` and `client` are reserved namespace names, registered like any other; others are ' +
        'namespaces you registered yourself. This is the ' +
        'folder\'s COMPLETE scope declaration and values must come from the credential\'s own identity. ' +
        'An empty array `[]` creates a PRIVATE folder owned by the calling user alone. Omit to stamp the ' +
        'credential\'s full identity — the default.',
    ),
};

const folderCreate: ToolFactory = ({ client, log }) => ({
  name: 'folder_create',
  title: 'Create a folder',
  description:
    'Create a folder to organize documents and records. Pass `parentId` to nest it (create-only — folders ' +
    'cannot be moved later). Idempotent by `slug` within the parent ONLY when you pass `slug` explicitly — ' +
    'omitting it derives a fresh, always-free slug on every call, so a retry creates a new sibling folder ' +
    'rather than matching the first. Requires the key to allow folders:c (and folders:r to receive the ' +
    'existing folder on a collision).',
  inputSchema,
  // Idempotent ONLY when the caller supplies `slug` explicitly (see the doc comment above): an
  // omitted slug is derived through a collision-probing suffix loop that returns only a
  // freshly-proved-free value, so the idempotency check running after that derivation can never
  // match on the default path. `slug` is optional, so this is annotated for the less-safe default —
  // the same standard applied to record_create/document_ingest/record_batch_write's identical
  // optional-dedupe-key shape. (A prior version of this annotation claimed unconditional
  // idempotency, reasoning that the derived slug made this tool "genuinely structurally different"
  // from the optional-externalId tools — that reasoning was wrong: the derivation is unconditional,
  // but it is unconditionally NON-colliding by construction, which is the opposite property.)
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (args): Promise<ToolResult> => {
    try {
      const folder = await client.folders.createFolder({
        body: {
          name: args.name as string,
          description: args.description as string | undefined,
          parentFolderId: args.parentId as string | undefined,
          slug: args.slug as string | undefined,
          userId: args.userId as string | undefined,
          scopes: args.scopes as string[] | undefined,
        },
      });
      log.debug({ tool: 'folder_create', id: folder.id, name: folder.name }, 'folder_create ok');
      return { content: [{ type: 'text', text: JSON.stringify(folder, null, 2) }] };
    } catch (err) {
      log.warn({ tool: 'folder_create', err: String(err) }, 'folder_create failed');
      return toolError('folder_create', err);
    }
  },
});

export default folderCreate;
