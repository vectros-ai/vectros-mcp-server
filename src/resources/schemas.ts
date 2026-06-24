/**
 * schemas resource at `vectros://schemas`.
 *
 * Parallel to the `list_schemas` tool — same data, different access
 * pattern. MCP clients can list/read resources passively (without
 * a tool call) to surface ambient context to the agent.
 *
 * Returns the full schema catalog as JSON text (mimeType
 * application/json). Honors the credential's AccessProfile scope —
 * exactly what `list_schemas` returns with no filters.
 *
 * `listSchemas` returns the `{ data, nextCursor }` page envelope (SDK
 * 0.23); we drain every page into the flat `SchemaResponse[]` so the
 * resource body stays a bare array — in lockstep with the `list_schemas`
 * tool. See src/paging.ts.
 */
import type { Vectros } from '@vectros-ai/sdk';
import type { ResourceFactory } from './types.js';
import { drainPages } from '../paging.js';

const schemasResource: ResourceFactory = ({ client }) => ({
  name: 'schemas',
  uri: 'vectros://schemas',
  title: 'Record schema catalog',
  description:
    'The structured-record schema catalog visible to the current credential. Each schema describes a ' +
    'record type (e.g. "patient", "clinical_note"), its fields, lookup-indexed fields, and capabilities. ' +
    'Equivalent to calling the `list_schemas` tool with no filters.',
  mimeType: 'application/json',
  read: async (): Promise<string> => {
    const schemas = await drainPages<Vectros.SchemaResponse>((startFrom) =>
      client.schemas.listSchemas({ startFrom }),
    );
    return JSON.stringify(schemas, null, 2);
  },
});

export default schemasResource;
