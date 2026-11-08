/**
 * Size limits the Vectros API itself enforces on array arguments. The tools refuse an oversized
 * array before the call, with the same limit the API would apply, so a request the API would reject
 * costs no round trip and an unbounded array never reaches the argument validator.
 */

/** A write names at most two ownership scopes: one value per namespace, at most two namespaces. */
export const MAX_OWNERSHIP_SCOPES = 2;

/** A search or grounded answer takes at most 16 `scopeFilters` entries. */
export const MAX_SCOPE_FILTERS = 16;

/**
 * `contentTypes` names `documents`, `records`, or both (both means no narrowing), so a longer list can
 * only repeat a value. The API states no limit on the count; this one is applied by the tool.
 */
export const MAX_CONTENT_TYPES = 2;
