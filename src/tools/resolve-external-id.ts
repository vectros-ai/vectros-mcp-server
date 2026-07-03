/**
 * Resolve a record/document by the caller's `externalId` → the internal Vectros `id`.
 *
 * externalId is unique WITHIN a type, so resolution needs both `type` and `externalId`.
 * This lets record_get / record_update (and the document tools) accept externalId as a
 * first-class selector — the same key the caller passed to create — instead of forcing a
 * manual record_query lookup first (it closes the create-by-externalId / act-by-id
 * asymmetry). The lookup routes through the POST-body variant (sensitive-safe, value never
 * in the URL), mirroring record_query / document_query.
 */
import type { VectrosClient } from '@vectros-ai/sdk';
import { pageItems } from '../paging.js';

export interface Selector {
  id?: string;
  externalId?: string;
  type?: string;
}

export type Resolved = { id: string } | { error: string };

/** Validate that exactly one selector shape was supplied (id XOR externalId+type). */
function validateSelector(sel: Selector, entity: string): string | undefined {
  const hasId = sel.id !== undefined && sel.id !== '';
  const hasExt = sel.externalId !== undefined && sel.externalId !== '';
  if (hasId && hasExt) {
    return `Provide either id or externalId (not both) to identify the ${entity}.`;
  }
  if (!hasId && !hasExt) {
    return `Provide id, or externalId + type, to identify the ${entity}.`;
  }
  if (hasExt && (sel.type === undefined || sel.type === '')) {
    return 'type is required when selecting by externalId (externalId is unique within a type).';
  }
  return undefined;
}

export async function resolveRecordIdByExternalId(
  client: VectrosClient,
  sel: Selector,
): Promise<Resolved> {
  const err = validateSelector(sel, 'record');
  if (err) return { error: err };
  if (sel.id) return { id: sel.id };
  const page = await client.records.lookupRecordsByBody({
    type: sel.type!,
    field: 'externalId',
    value: sel.externalId!,
    limit: 1,
  });
  const items = pageItems(page);
  if (items.length === 0) {
    return { error: `No record of type '${sel.type}' with externalId '${sel.externalId}'.` };
  }
  return { id: items[0].id as string };
}

export async function resolveDocumentIdByExternalId(
  client: VectrosClient,
  sel: Selector,
): Promise<Resolved> {
  const err = validateSelector(sel, 'document');
  if (err) return { error: err };
  if (sel.id) return { id: sel.id };
  const page = await client.documents.lookupDocumentsByBody({
    type: sel.type!,
    field: 'externalId',
    value: sel.externalId!,
    limit: 1,
  });
  const items = pageItems(page);
  if (items.length === 0) {
    return { error: `No document of type '${sel.type}' with externalId '${sel.externalId}'.` };
  }
  return { id: items[0].id as string };
}
