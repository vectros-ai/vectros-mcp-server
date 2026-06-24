/**
 * Base-URL validator — credential-exfil guard.
 *
 * `VECTROS_API_BASE_URL` flows unchecked into `resolveIdentity`, which sends
 * `Authorization: Bearer ${VECTROS_API_KEY}` to `${baseUrl}/v1/ping` — so an
 * attacker-supplied base URL exfiltrates the operator's API key (commonly a
 * root `sk_*`). Same vector the CLI has via the Cognito bearer.
 *
 * This validates the URL BEFORE the server attaches any credential:
 *   - require `https://` — except `http://` to a loopback host (localhost/
 *     127.0.0.1/::1), for local proxying/dev;
 *   - require the host to be an official Vectros host: `vectros.ai` or a
 *     `*.vectros.ai` subdomain (strict suffix match — `api.vectros.ai.evil.com`
 *     and `evilvectros.ai` are rejected);
 *   - a loud, explicit opt-out (`VECTROS_ALLOW_INSECURE_BASE_URL=1`) permits
 *     an arbitrary host for a trusted local proxy, AFTER a warning.
 *
 * Mirrors `packages/cli/src/base-url.ts`. Kept as a tiny per-package module
 * rather than a new shared workspace dependency. Warnings go to stderr (or an
 * injected logger) — NEVER stdout (stdio-transport purity).
 */

/** The official Vectros apex + subdomain suffix. */
const ALLOWED_HOST_APEX = 'vectros.ai';
const ALLOWED_HOST_SUFFIX = '.vectros.ai';

/** Env var that loudly opts out of the host allow-list (trusted local proxy). */
export const INSECURE_BASE_URL_ENV = 'VECTROS_ALLOW_INSECURE_BASE_URL';

/** Thrown when a base URL fails validation. */
export class InvalidBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBaseUrlError';
  }
}

export interface ValidateBaseUrlOptions {
  /**
   * When true, permit any http/https host (loud opt-out). Defaults to reading
   * {@link INSECURE_BASE_URL_ENV} from the environment.
   */
  allowInsecure?: boolean;
  /** Sink for the loud opt-out warning. Defaults to stderr (stdout-purity). */
  warn?: (msg: string) => void;
}

/** localhost / 127.0.0.1 / ::1 (URL.hostname keeps IPv6 brackets). */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function insecureOptOutFromEnv(): boolean {
  const v = (process.env[INSECURE_BASE_URL_ENV] ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function defaultWarn(msg: string): void {
  // stderr only — stdout carries the MCP protocol on the stdio transport.
  process.stderr.write(`${msg}\n`);
}

/**
 * Validate a base URL and return it unchanged on success. Throws
 * {@link InvalidBaseUrlError} otherwise.
 */
export function validateBaseUrl(rawUrl: string, opts: ValidateBaseUrlOptions = {}): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InvalidBaseUrlError(
      `Invalid base URL ${JSON.stringify(rawUrl)} — not a parseable absolute URL ` +
        `(expected e.g. https://api.vectros.ai).`,
    );
  }

  const allowInsecure = opts.allowInsecure ?? insecureOptOutFromEnv();
  const scheme = url.protocol;
  // Strip a single trailing dot (the FQDN form `api.vectros.ai.` is a legit
  // alias of the real host) so the suffix/loopback checks treat them alike.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = isLoopbackHost(host);

  if (allowInsecure) {
    if (scheme !== 'https:' && scheme !== 'http:') {
      throw new InvalidBaseUrlError(
        `Refusing base URL with scheme "${scheme}" — only http/https are supported.`,
      );
    }
    (opts.warn ?? defaultWarn)(
      `WARNING: ${INSECURE_BASE_URL_ENV} is set — sending Vectros credentials to ` +
        `UNVALIDATED host "${url.host}". This bypasses the base-URL allow-list and can leak ` +
        `your API key. Unset it unless you are intentionally proxying to a trusted local endpoint.`,
    );
    return rawUrl;
  }

  if (scheme === 'http:') {
    if (!loopback) {
      throw new InvalidBaseUrlError(
        `Refusing insecure http:// base URL for non-loopback host "${url.host}". ` +
          `Use https:// (or set ${INSECURE_BASE_URL_ENV}=1 to override for a trusted local proxy).`,
      );
    }
    return rawUrl;
  }
  if (scheme !== 'https:') {
    throw new InvalidBaseUrlError(
      `Refusing base URL with scheme "${scheme}" — only https:// (or http:// to localhost) is allowed.`,
    );
  }

  if (loopback) return rawUrl;
  if (host === ALLOWED_HOST_APEX || host.endsWith(ALLOWED_HOST_SUFFIX)) {
    return rawUrl;
  }

  throw new InvalidBaseUrlError(
    `Refusing base URL host "${url.host}" — not an official Vectros host (expected vectros.ai ` +
      `or a *.vectros.ai subdomain). Set ${INSECURE_BASE_URL_ENV}=1 to override (e.g. for a ` +
      `trusted local proxy); never point the MCP server at an untrusted host while authenticated.`,
  );
}
