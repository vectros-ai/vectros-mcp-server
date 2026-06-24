/**
 * Shared identity-resolution helper.
 *
 * Used by BOTH `current_identity` tool AND `identity` resource —
 * single source of truth for the graceful-degradation contract (see
 * the design doc § Identity & exploration →
 * current_identity + § "Backend deliverables surfaced by MCP v0.2").
 *
 * Bypasses the SDK because `client.auth.ping()` is typed
 * `Promise<void>` and discards the response body — see
 * src/tools/current_identity.ts header for the full reasoning.
 */
import type { Logger } from './log.js';

export interface IdentityShape {
  status: 'ok';
  environment?: 'staging' | 'production';
  principalType?: 'root_key' | 'scoped_key' | 'token';
  // Extended fields (present once backend ships extended /v1/ping):
  tenantId?: string;
  principalKeyId?: string;
  principalLabel?: string;
  allowedActions?: string[];
  dataScope?: { userId?: string; orgId?: string };
  tokenExpiresAt?: number;
  // Allow pass-through of any future backend-added fields without
  // requiring an MCP server release.
  [key: string]: unknown;
}

export function deriveEnvironment(
  environment: string | undefined,
): 'staging' | 'production' | undefined {
  if (!environment) return undefined;
  if (environment.includes('staging')) return 'staging';
  if (environment.includes('api.vectros.ai')) return 'production';
  return undefined;
}

export function derivePrincipalType(
  apiKey: string | undefined,
): 'root_key' | 'scoped_key' | 'token' | undefined {
  if (!apiKey) return undefined;
  const prefix = apiKey.split('_')[0];
  if (prefix === 'sk') return 'root_key';
  if (prefix === 'ssk') return 'scoped_key';
  if (prefix === 'st') return 'token';
  return undefined;
}

export interface ResolveIdentityCtx {
  log: Logger;
  apiKey?: string;
  environment?: string;
}

/**
 * Resolve identity: raw GET /v1/ping + client-side derivation,
 * merged with extended-shape graceful-degradation semantics.
 *
 * Throws if /v1/ping returns non-2xx (auth failure or upstream).
 * Caller is responsible for wrapping into a tool/resource error.
 *
 * Returns the derived-only shape when apiKey or environment is
 * missing (e.g., test mocks omit them, or programmatic embedders
 * skip them).
 */
export async function resolveIdentity({
  log,
  apiKey,
  environment,
}: ResolveIdentityCtx): Promise<IdentityShape> {
  const derived: IdentityShape = {
    status: 'ok',
    environment: deriveEnvironment(environment),
    principalType: derivePrincipalType(apiKey),
  };

  if (!apiKey || !environment) {
    log.debug({ component: 'identity', mode: 'derived-only' }, 'identity derived (no fetch)');
    return derived;
  }

  const url = `${environment.replace(/\/$/, '')}/v1/ping`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`HTTP ${res.status}: ${body || res.statusText}`) as Error & {
      statusCode: number;
    };
    e.statusCode = res.status;
    throw e;
  }

  // Parse body if any. Old endpoint returns empty body; extended
  // endpoint returns identity JSON.
  let extended: Record<string, unknown> = {};
  const rawBody = await res.text();
  if (rawBody.trim().length > 0) {
    try {
      extended = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      log.debug(
        { component: 'identity', rawBodyLen: rawBody.length },
        'identity: ping body not JSON, using derived shape only',
      );
    }
  }

  // Merge derived + extended. Extended fields override derived
  // (backend is authoritative once it ships them).
  const merged: IdentityShape = { ...derived, ...extended, status: 'ok' };

  log.debug(
    {
      component: 'identity',
      mode: rawBody.trim().length > 0 ? 'extended' : 'derived',
      fields: Object.keys(merged),
    },
    'identity resolved',
  );

  return merged;
}
