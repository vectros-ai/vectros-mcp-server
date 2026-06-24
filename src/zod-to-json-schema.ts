/**
 * Custom zod → JSON Schema converter.
 *
 * We do this in-tree (rather than depending on `zod-to-json-schema`)
 * because we only need to support the small subset of zod shapes our
 * tool input schemas use: object, string, number, boolean, enum,
 * array, plus the unwrap-modifier triad (optional / default /
 * nullable). The output is the JSON Schema fragment that MCP's
 * `tools/list` response embeds for each tool.
 *
 * Exported separately from server.ts so it can be unit-tested in
 * isolation. The integration test sees the converted output via
 * `tools/list`, but doesn't assert the converted-shape semantics
 * (e.g., that required fields drop their unwrapped modifier).
 */
import { z } from 'zod';

/**
 * Convert a zod raw-shape object (the value passed to `z.object(...)`)
 * into a JSON Schema object describing the same shape.
 */
export function zodShapeToJsonSchema(
  shape: Record<string, z.ZodTypeAny>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, schema] of Object.entries(shape)) {
    properties[name] = zodTypeToJsonSchema(schema);
    if (!schema.isOptional()) required.push(name);
  }
  const out: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

/**
 * Convert a single zod type into a JSON Schema fragment. Unwraps
 * Optional / Default / Nullable layers transparently — the
 * `required` list in the parent object tracks whether a field is
 * required separately.
 */
export function zodTypeToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Capture the description BEFORE unwrapping — wrappers carry it.
  const description = (schema as unknown as { description?: string }).description;

  // Unwrap modifiers.
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodNullable
  ) {
    current = (current as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
  }

  const base: Record<string, unknown> = description ? { description } : {};

  if (current instanceof z.ZodString) {
    return { ...base, type: 'string' };
  }
  if (current instanceof z.ZodNumber) {
    return { ...base, type: 'number' };
  }
  if (current instanceof z.ZodBoolean) {
    return { ...base, type: 'boolean' };
  }
  if (current instanceof z.ZodEnum) {
    return {
      ...base,
      type: 'string',
      enum: (current as z.ZodEnum<[string, ...string[]]>).options,
    };
  }
  if (current instanceof z.ZodArray) {
    return {
      ...base,
      type: 'array',
      items: zodTypeToJsonSchema((current as z.ZodArray<z.ZodTypeAny>).element),
    };
  }
  if (current instanceof z.ZodObject) {
    return {
      ...base,
      ...zodShapeToJsonSchema((current as z.ZodObject<z.ZodRawShape>).shape),
    };
  }
  if (current instanceof z.ZodRecord) {
    // `z.record(...)` → an open-keyed object. Describe it as `type: object`
    // with `additionalProperties` carrying the value schema, so the field
    // advertises a real shape to MCP clients instead of an empty fragment.
    const valueType = (current as unknown as { _def: { valueType: z.ZodTypeAny } })._def.valueType;
    return {
      ...base,
      type: 'object',
      additionalProperties: zodTypeToJsonSchema(valueType),
    };
  }
  // Fallback — let the MCP SDK be tolerant.
  return { ...base };
}
