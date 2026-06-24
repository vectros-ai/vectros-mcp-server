/**
 * API key format validation + credential-type warnings.
 *
 * Vectros has three credential types:
 *   sk_*   — root API key. Wildcard scope. Too broad for desktop MCP;
 *            warn the user on accept.
 *   ssk_*  — server-side scoped key. Long-lived, narrowable scope.
 *            The RECOMMENDED credential for MCP. Accept silently.
 *   st_*   — short-lived KMS-signed JWT (1h default / 24h max).
 *            Will expire mid-session; warn the user on accept.
 *
 * See the Vectros developer documentation on the auth model and
 * scoped tokens ("When ssk_* is the right call") for the full rationale.
 */
import type { Logger } from './log.js';

export type KeyPrefix = 'sk' | 'ssk' | 'st';
export type KeyEnv = 'live' | 'test';

export interface KeyInfo {
  prefix: KeyPrefix;
  env: KeyEnv;
  raw: string;
}

const KEY_RE = /^(sk|ssk|st)_(live|test)_/;

export class InvalidApiKeyError extends Error {
  constructor(reason: string) {
    super(`Invalid VECTROS_API_KEY: ${reason}`);
    this.name = 'InvalidApiKeyError';
  }
}

/**
 * Parse and validate the API key. Throws `InvalidApiKeyError` on
 * malformed keys (caller should let the exception propagate — bad
 * creds are a fail-fast condition at startup).
 */
export function parseApiKey(raw: string | undefined): KeyInfo {
  if (!raw || raw.trim().length === 0) {
    throw new InvalidApiKeyError(
      'env var is missing or empty. ' +
        'Set VECTROS_API_KEY to a Vectros key (recommended: ssk_live_... or ssk_test_...).',
    );
  }
  const match = raw.match(KEY_RE);
  if (!match) {
    throw new InvalidApiKeyError(
      `key must start with sk_, ssk_, or st_ followed by "live_" or "test_". Got prefix "${raw.slice(0, 12)}...".`,
    );
  }
  return {
    prefix: match[1] as KeyPrefix,
    env: match[2] as KeyEnv,
    raw,
  };
}

/**
 * Warn (via logger) on credential types that are technically valid
 * but not ideal for an MCP server:
 *   - sk_* — wildcard scope is too broad for desktop credentials
 *   - st_* — short-lived; will expire mid-session
 *
 * ssk_* passes silently — it's the recommended shape.
 */
export function warnOnSuboptimalKey(key: KeyInfo, log: Logger): void {
  if (key.prefix === 'sk') {
    log.warn(
      { prefix: key.prefix, env: key.env },
      'wildcard-scope key (sk_*) on a desktop MCP server is overly broad. ' +
        'For production, prefer a scoped ssk_* key bound to a narrowed AccessProfile. ' +
        'See the Vectros scoped-token documentation ("Recommended AccessProfile for MCP").',
    );
  } else if (key.prefix === 'st') {
    log.warn(
      { prefix: key.prefix, env: key.env },
      'short-lived token (st_*) will expire mid-session (1h default, 24h max). ' +
        'For long-running MCP installs, prefer a long-lived ssk_* key.',
    );
  }
  // ssk_* — no warning.
}
