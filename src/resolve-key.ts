/**
 * Resolve the Vectros API key this server runs with, from a small precedence
 * chain — so a credential lives in ONE place and every consumer (this server,
 * agent hooks, plain scripts) reads the same source, instead of each embedding
 * its own plaintext copy that silently drifts:
 *
 *   1. VECTROS_API_KEY env — wins if set (explicit override + back-compat).
 *   2. else the CLI credential helper: `vectros keyring show --format raw`
 *      (`--alias` from VECTROS_KEYRING_ALIAS; default = the keyring's active
 *      entry). The helper is invoked as a SUBPROCESS — zero code coupling: the
 *      server never imports the CLI, it only reads a stable one-line text
 *      contract (the same shape as `git credential`, `docker-credential-*`,
 *      `aws credential_process`).
 *   3. else nothing — the caller emits the actionable "set VECTROS_API_KEY /
 *      install the CLI" error.
 *
 * `show --format raw` is the CLI's long-standing bare-secret contract, and the
 * helper deliberately depends on nothing newer: it must work against the CLI a
 * user ALREADY has installed, not only the latest. Inventing a friendlier verb
 * for the same output would fail with "unknown command" on every published CLI —
 * i.e. for precisely the users this fallback exists to help. If the contract ever
 * needs to carry more than a secret (a short-TTL descriptor with an expiry, say),
 * it extends along the existing `--format` axis, and this call site should keep
 * asking for the oldest format that satisfies it.
 *
 * The resolved secret is held in memory only and is NEVER logged. Text that DOES
 * reach a log (a helper failure `detail`) is redacted + capped on the way out —
 * the helper is a separately-versioned binary, so "its output never contains a
 * key" is not ours to guarantee.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/** Where a resolved key came from — for a non-secret startup log line. */
export type KeySource = 'env' | 'keyring' | 'none';

/** Why resolution produced no key (drives the actionable startup error). */
export type NoKeyReason = 'cli-absent' | 'no-usable-key' | 'helper-failed' | 'bad-alias';

export interface ResolvedApiKey {
  /** The raw secret, when resolved. Absent when `source === 'none'`. */
  key?: string;
  source: KeySource;
  /** The keyring alias consulted, when one was named. Non-secret — safe to log. */
  alias?: string;
  /** Present only when `source === 'none'`. */
  reason?: NoKeyReason;
  /** Extra context for `helper-failed` — redacted + capped by {@link redactDetail}. */
  detail?: string;
}

/** The outcome of running the CLI helper (the injectable seam's return shape). */
export type HelperOutcome =
  | { status: 'ok'; secret: string }
  | { status: 'cli-absent' }
  /** The CLI ran and reported it has no key for us; `detail` is its own message. */
  | { status: 'no-usable-key'; detail?: string }
  | { status: 'error'; detail: string };

export interface HelperArgs {
  /** A validated keyring alias, or undefined for the active entry. */
  alias?: string;
  env: NodeJS.ProcessEnv;
}

export interface KeyResolverDeps {
  /** Environment to read (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Override the helper runner — tests inject this so no real subprocess spawns. */
  runHelper?: (args: HelperArgs) => Promise<HelperOutcome>;
}

/** The CLI binary the helper shells out to. */
const HELPER_COMMAND = 'vectros';
/** Cap the helper wait so a wedged CLI can't hang server startup. */
const HELPER_TIMEOUT_MS = 10_000;
/** A helper secret is a single short line; bound the buffer defensively. */
const HELPER_MAX_BUFFER = 64 * 1024;
/**
 * Valid keyring-alias charset. Enforced BEFORE the alias reaches the shell (the
 * Windows spawn path needs a shell to resolve the `vectros.cmd` shim), so an
 * alias can never carry shell metacharacters. Matches the CLI's own alias shape.
 */
const ALIAS_RE = /^[A-Za-z0-9._-]+$/;
/**
 * Vectros credential shapes, redacted from anything that can reach a log.
 * Deliberately NOT anchored with `\b`: `_` is a word character, so `\b` FAILS to
 * match a key embedded after one (`MY_KEY_ssk_live_…`) — the anchor would have
 * excused exactly the case worth catching. Case-insensitive for the same reason.
 */
const SECRET_RE = /(?:ssk|sk|st)_(?:live|test)_[A-Za-z0-9._-]+/gi;
/** Helper failure text is diagnostic, not a transcript — keep it to one line. */
const DETAIL_MAX_CHARS = 200;

/**
 * Resolve the API key per the precedence above. Pure orchestration — the actual
 * subprocess lives in {@link defaultRunHelper}, swapped out in tests via
 * {@link KeyResolverDeps.runHelper}.
 */
export async function resolveApiKey(deps: KeyResolverDeps = {}): Promise<ResolvedApiKey> {
  const env = deps.env ?? process.env;

  // 1. Env wins. Treat an empty/whitespace value as unset so a stray blank
  //    export doesn't shadow a perfectly good keyring entry. Trim the value:
  //    this module makes `VECTROS_API_KEY=$(vectros keyring show --format raw)`
  //    the blessed pattern, and command substitution keeps a trailing newline
  //    that would otherwise sail past parseApiKey's prefix check and die much
  //    later as an opaque invalid-header error.
  const envKey = env.VECTROS_API_KEY;
  if (envKey && envKey.trim().length > 0) {
    return { key: envKey.trim(), source: 'env' };
  }

  // 2. CLI credential helper. Validate the alias here (always enforced, even
  //    when a test injects runHelper) so the shell path is never handed metachars.
  const alias = env.VECTROS_KEYRING_ALIAS?.trim() || undefined;
  if (alias !== undefined && !ALIAS_RE.test(alias)) {
    return {
      source: 'none',
      reason: 'bad-alias',
      detail: 'VECTROS_KEYRING_ALIAS must be letters, digits, dot, dash, or underscore.',
    };
  }

  const runHelper = deps.runHelper ?? defaultRunHelper;
  const outcome = await runHelper({ alias, env });
  switch (outcome.status) {
    case 'ok':
      return { key: outcome.secret, source: 'keyring', alias };
    case 'cli-absent':
      return { source: 'none', reason: 'cli-absent', alias };
    // Redact HERE as well as in mapExecResult: `runHelper` is a public injectable
    // seam, so redacting only inside the default implementation would leave any
    // other implementation's text to reach the fatal log raw. Belongs at the sink.
    case 'no-usable-key':
      return {
        source: 'none',
        reason: 'no-usable-key',
        alias,
        detail: outcome.detail ? redactDetail(outcome.detail) : undefined,
      };
    case 'error':
      return { source: 'none', reason: 'helper-failed', alias, detail: redactDetail(outcome.detail) };
  }
}

/**
 * The actionable startup message for a `source === 'none'` resolution — one
 * string the entrypoint logs as fatal. Every branch names BOTH escape hatches
 * (the env var and the CLI) so the user is never stuck.
 *
 * Note what is NOT suggested unconditionally: `vectros keyring doctor` ships in
 * CLI 0.10.0, so for anyone on an older build — exactly the readers a
 * keyring-resolution failure reaches — it is another unknown command. Where it is
 * mentioned it carries its floor, and every branch offers a remedy that works
 * without it.
 */
export function noKeyMessage(resolved: ResolvedApiKey): string {
  // Lower-case: this clause is always spliced mid-sentence after "or"/"Either".
  const setEnv = 'set VECTROS_API_KEY to a Vectros key (recommended: ssk_live_…)';
  switch (resolved.reason) {
    case 'cli-absent':
      return (
        `no API key: VECTROS_API_KEY is unset and the \`vectros\` CLI is not on PATH. ` +
        `Either ${setEnv}, or install @vectros-ai/cli and run \`vectros switch <alias>\`.`
      );
    case 'no-usable-key':
      // Covers CLI exit 2 (no active identity / no such alias), exit 1 (entry
      // found but its secret won't decrypt), the CLI's catch-all (a corrupt
      // index), and an outdated CLI that doesn't know the command. We can't tell
      // those apart from the exit code — so state only what we know, and let the
      // CLI's own message (detail) supply the cause when it gave us one.
      return (
        `no API key: VECTROS_API_KEY is unset and \`vectros keyring show\` returned no key` +
        `${resolved.detail ? ` — ${resolved.detail}` : ''}. ` +
        `Run \`vectros switch <alias>\` to pick an identity, \`vectros keyring doctor\` to ` +
        `inspect the keyring (CLI 0.10.0+), upgrade @vectros-ai/cli if it predates the ` +
        `keyring (0.9.0), or ${setEnv}.`
      );
    case 'bad-alias':
      return (
        `invalid VECTROS_KEYRING_ALIAS: ${resolved.detail ?? 'not a valid keyring alias'} ` +
        `Run \`vectros keyring list\` to see the entry names, unset it to use the active ` +
        `identity, or ${setEnv}.`
      );
    case 'helper-failed':
      return (
        `no API key: VECTROS_API_KEY is unset and the \`vectros keyring show\` helper failed ` +
        `(${resolved.detail ?? 'unknown error'}). Upgrade @vectros-ai/cli if it is an old ` +
        `build, or ${setEnv} to bypass the keyring.`
      );
    default:
      return `no API key: ${setEnv}.`;
  }
}

/** The non-secret startup disclosure for a key that came from the keyring. */
export interface KeyResolutionNotice {
  level: 'info' | 'warn';
  /** The entry consulted — an alias, or `(active)` when the keyring chose. */
  alias: string;
  message: string;
}

/**
 * What to say at startup about a keyring-resolved key, or undefined when the key
 * didn't come from the keyring (an env key is explicit — nothing to disclose).
 *
 * WARNS whenever the key came from the keyring's ACTIVE entry with no alias
 * named, because that is the one path nobody chose deliberately:
 * `VECTROS_API_KEY: ""` is a common placeholder in MCP client templates (and a
 * Docker `-e` pass-through of an unset var arrives the same way), so a user who
 * believes this server is unconfigured gets it running as whatever
 * `vectros switch` last selected.
 *
 * The warning does NOT depend on which credential turned up. Landing on a live
 * key you didn't pick and landing on a test key you didn't pick are both
 * unwelcome surprises — one silently touches real data, the other silently
 * doesn't — so the trigger is the implicitness, not the key. Naming an alias is
 * a deliberate act and stays at info; nothing is ever blocked.
 */
export function keyringNotice(resolved: ResolvedApiKey): KeyResolutionNotice | undefined {
  if (resolved.source !== 'keyring') return undefined;
  if (resolved.alias !== undefined) {
    return { level: 'info', alias: resolved.alias, message: 'resolved API key from the vectros CLI keyring' };
  }
  return {
    level: 'warn',
    alias: '(active)',
    message:
      'resolved API key from the vectros CLI keyring: no entry was named, so this server is ' +
      'running as whatever identity `vectros switch` last made active. Set VECTROS_API_KEY, or ' +
      'VECTROS_KEYRING_ALIAS, to choose deliberately — `vectros keyring doctor` shows which ' +
      'entry is active and whether it holds a live key.',
  };
}

/**
 * Strip anything key-shaped out of helper failure text and cap it. The helper is
 * a separately-versioned binary whose stderr we do not control, and this text is
 * logged at fatal — so redact rather than trust. Also bounds a pathological
 * multi-KB stderr to one readable line.
 */
export function redactDetail(message: string): string {
  // Redaction strictly precedes truncation, so a cut can never expose the prefix
  // of a key the match would have caught.
  //
  // Honest about the limit: this is a shape denylist, so it means "no
  // currently-shaped key", not "no secret". A key split across whitespace still
  // leaks its tail (the match stops at the break), and a future prefix is by
  // definition uncovered — which is the point of only ever passing the CLI's own
  // diagnostic text through here, never its stdout.
  const redacted = message.replace(/\s+/g, ' ').trim().replace(SECRET_RE, '[redacted]');
  return redacted.length > DETAIL_MAX_CHARS ? `${redacted.slice(0, DETAIL_MAX_CHARS)}…` : redacted;
}

/**
 * Resolve `command` to an ABSOLUTE path via PATH (+ PATHEXT on Windows), or
 * undefined when it isn't installed.
 *
 * Returning the path — rather than a boolean — is load-bearing for security, not
 * just diagnostics. The Windows spawn needs a shell (Node refuses to launch the
 * `vectros.cmd` npm shim without one), and `cmd.exe` resolves a bare command
 * name from the CURRENT DIRECTORY before PATH. Spawning the bare name would let
 * a stray `.\vectros.bat` — in, say, a freshly cloned repo the server was
 * started in — run instead of the trusted binary this lookup just found. We hand
 * execFile the exact file we validated.
 */
export function resolveCommandPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  if (!pathVar) return undefined;
  // `||` not `??`: PATHEXT='' must fall back to the defaults, not produce an
  // empty extension list that silently matches nothing and reports "not installed".
  const exts =
    platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.trim())
          .filter(Boolean)
      : [''];
  for (const rawDir of pathVar.split(path.delimiter)) {
    // Windows PATH entries may be quoted ("C:\tools\bin"); strip before joining
    // or the quotes become part of the path and the lookup silently misses.
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    // A RELATIVE PATH entry (`.` is the classic) resolves against the cwd, which
    // is the entire attack this function exists to stop: `path.join('.', 'vectros')`
    // yields a bare relative name, statSync would find a malicious `./vectros` in
    // whatever directory the server was started in, and handing that name to the
    // shell lets cmd.exe resolve it from the cwd all over again. Absolute or
    // nothing — this precondition is what the rest of the security argument rests on.
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        // isFile() matters: a DIRECTORY named `vectros` on PATH would satisfy a
        // bare existence check and then fail the spawn with a confusing EACCES.
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here — try the next dir/ext */
      }
    }
  }
  return undefined;
}

/**
 * Map execFile's `(err, stdout, stderr)` callback result to a {@link HelperOutcome}.
 * Extracted pure so the whole mapping contract is table-testable without
 * spawning anything.
 *
 * Exit codes come from the CLI's `keyring show`: 0 = secret on stdout,
 * 2 = no such entry / no active identity, 1 = the entry was found but its secret
 * is unreadable. 1 and 2 both mean "the keyring has no key for you" and share one
 * remedy, so they collapse to a single outcome.
 *
 * But 1 is ALSO the CLI's catch-all — a corrupt `keyring.json` throws there, and
 * so will a locked OS keychain later. We cannot tell those apart from the exit
 * code, so we carry the CLI's own stderr through as `detail` instead of asserting
 * a cause we don't know: it already says "Keyring index at … is corrupt", which
 * is the actionable thing, and discarding it to print a guess would be worse than
 * saying nothing. On a spawn failure execFile sets `err.code` to the string
 * errno; on a non-zero exit it is the number.
 */
export function mapExecResult(
  err: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr = '',
): HelperOutcome {
  if (!err) {
    const secret = stdout.trim();
    return secret ? { status: 'ok', secret } : { status: 'no-usable-key' };
  }
  const code = err.code;
  if (code === 'ENOENT') return { status: 'cli-absent' };
  // Prefer the child's own stderr; fall back to execFile's message (which embeds
  // the command line) only when the child said nothing.
  const detail = redactDetail(stderr.trim() || err.message);
  if (code === 1 || code === 2) return { status: 'no-usable-key', detail: detail || undefined };
  // Timeout, signal, maxBuffer overflow, or any other failure.
  return { status: 'error', detail };
}

/** The exec seam — `execFile`'s shape, narrowed to what the helper needs. */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean; shell: boolean },
  callback: (err: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void,
) => void;

/** Injectable platform + exec, so the WINDOWS spawn path is testable off Windows. */
export interface RunHelperDeps {
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileLike;
}

/**
 * Spawn `vectros keyring show --format raw [--alias <a>]` and map its result.
 *
 * Exported with injectable `platform`/`execFileImpl` deliberately: this function —
 * not resolveCommandPath — is where the spawn-hijack fix is APPLIED (the quoting,
 * the shell decision, the composed argv). Leaving it module-private meant the
 * riskiest code in the file was the only code a test could not reach, and reading
 * `process.platform` directly meant the Windows branch could never be exercised on
 * a POSIX CI runner. Both are now injectable so the argv can be asserted.
 */
export function defaultRunHelper(
  { alias, env }: HelperArgs,
  deps: RunHelperDeps = {},
): Promise<HelperOutcome> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.execFileImpl ?? (execFile as unknown as ExecFileLike);
  const resolved = resolveCommandPath(HELPER_COMMAND, env, platform);
  // Absence is decided by the lookup, not the spawn: on Windows the shell
  // reports a missing command as an opaque exit 1, not ENOENT, so without this
  // "you haven't installed the CLI" would surface as a generic helper failure.
  if (!resolved) return Promise.resolve({ status: 'cli-absent' });

  const isWindows = platform === 'win32';
  const args = ['keyring', 'show', '--format', 'raw', ...(alias ? ['--alias', alias] : [])];
  // `shell` does no quoting for us, and the resolved path may contain spaces
  // (C:\Program Files\…), so quote it ourselves on the shell path. resolveCommandPath
  // guarantees an absolute path, which is what stops cmd.exe re-resolving a bare
  // name from the current directory.
  const file = isWindows ? `"${resolved}"` : resolved;

  return new Promise((resolve) => {
    exec(
      file,
      args,
      {
        env,
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: HELPER_MAX_BUFFER,
        windowsHide: true,
        shell: isWindows,
      },
      (err, stdout, stderr) => resolve(mapExecResult(err, String(stdout ?? ''), String(stderr ?? ''))),
    );
  });
}
