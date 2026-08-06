/**
 * Build-provenance integrity test.
 *
 * `src/build-info.ts` stamps `__MCP_VERSION__`/`__SDK_VERSION__` into the
 * COMPILED binary at build time (tsup `define`); `tests/unit/build-info.test.ts`
 * only exercises the 'dev' fallback under tsx, since tsup's `define` never
 * applies there — so nothing in this repo's test suite had ever asserted that
 * a REAL build actually stamps the version it was supposed to.
 *
 * That gap is not hypothetical: an `npm install`/`npm ci` resolution quirk
 * (observed on this exact package, when a sibling workspace exact-pins a
 * DIFFERENT prerelease build of `@vectros-ai/sdk`) can silently leave the
 * WRONG SDK version resolved in `node_modules` even though `package.json`
 * correctly declares the new one — `npm ci` does not fail on this (it only
 * validates top-level dependency declarations, not that every nested resolved
 * entry matches them), so the build succeeds, the unit suite passes, and the
 * published binary would silently ship the OLD SDK bundled inside a package
 * whose version/CHANGELOG both claim the new one. This test is the guard: it
 * reads the ACTUAL built `dist/cli.js`'s `--version` output and cross-checks
 * it against `package.json`'s own declared versions, so that specific failure
 * mode goes red here instead of shipping silently.
 *
 * Two distinct checks, because one isn't enough: the BINARY's own --version
 * output necessarily reports a CLEAN base version (build-info.ts strips the
 * `-staging.<sha>` prerelease suffix, matching what a public-npm consumer
 * installs) — so it can catch a wrong BASE version, but two different
 * prerelease BUILDS of the SAME base version (e.g. a sibling workspace
 * pinning a different `-staging.<sha>`) both strip to the same string and
 * would pass that check regardless of which one actually got bundled. The
 * second check resolves the real on-disk `node_modules` package the same way
 * the build would and compares its full, un-stripped version against the
 * full, un-stripped pin — the only way to catch that case.
 *
 * Requires `npm run build` to have already produced `dist/` (same ordering
 * every other integration test in this directory already assumes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const PKG_ROOT = resolve(__dirname, '../..');
const CLI_PATH = resolve(PKG_ROOT, 'dist/cli.js');

interface PackageJson {
  name?: string;
  version: string;
  devDependencies: Record<string, string>;
}

/**
 * Resolve the installed `package.json` for `pkgName`, the same way Node (and the
 * bundler) would resolve `pkgName` itself from `fromDir` — NOT a hardcoded
 * `node_modules/<pkg>` path, since a sibling-workspace version conflict can leave
 * the real resolved copy nested under THIS package's own `node_modules` rather
 * than hoisted to the workspace root.
 *
 * Can't just `require.resolve('pkgName/package.json')`: that goes through the
 * package's `exports` map, and `@vectros-ai/sdk` doesn't export that subpath
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Instead resolve the package's real MAIN
 * entry (which every package must export) and walk up from there to the nearest
 * `package.json` whose `name` matches — that directory is the installed package
 * root, however it was resolved.
 */
function resolveInstalledPackageJson(pkgName: string, fromDir: string): { path: string; json: PackageJson } {
  const mainEntry = createRequire(resolve(fromDir, 'package.json')).resolve(pkgName);
  let dir = dirname(mainEntry);
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      const json = JSON.parse(readFileSync(candidate, 'utf8')) as PackageJson;
      if (json.name === pkgName) return { path: candidate, json };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate an installed package.json for '${pkgName}' walking up from ${mainEntry}`);
}

test('the BUILT binary reports the exact mcpServer + sdk versions package.json declares', () => {
  const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8')) as PackageJson;
  const declaredMcpVersion = pkg.version;
  const declaredSdkPin = pkg.devDependencies['@vectros-ai/sdk'];
  // The SDK devDependency pin often carries a `-staging.<sha>` prerelease
  // suffix (see tsup.config.ts's own depVersion() comment) — build-info.ts
  // strips that suffix before stamping, since the published binary reports
  // the clean base version a consumer installs from public npm.
  const declaredSdkVersion = declaredSdkPin.replace(/-staging\..*$/, '');

  const output = execFileSync('node', [CLI_PATH, '--version'], { encoding: 'utf8' }).trim();
  const match = /^vectros-mcp-server (\S+) \(sdk (\S+)\)$/.exec(output);
  assert.ok(match, `--version output did not match the expected shape: "${output}"`);
  const [, stampedMcpVersion, stampedSdkVersion] = match!;

  assert.equal(
    stampedMcpVersion,
    declaredMcpVersion,
    'the binary must report the exact package.json version it was built from',
  );
  assert.equal(
    stampedSdkVersion,
    declaredSdkVersion,
    'the binary must bundle the exact @vectros-ai/sdk BASE version package.json pins — a stale ' +
      'node_modules resolution (npm install/ci resolving a DIFFERENT SDK version than the one ' +
      'declared) would silently ship the wrong SDK inside a correctly-versioned package otherwise',
  );
  assert.notEqual(stampedMcpVersion, 'dev', 'must be a real build, not the tsx/no-define fallback');
  assert.notEqual(stampedSdkVersion, 'dev', 'must be a real build, not the tsx/no-define fallback');

  // The two checks above compare CLEAN BASE versions (prerelease suffix stripped on
  // both sides, by design — the stamped output reports what a public-npm consumer
  // sees). That means they CANNOT distinguish two different prerelease BUILDS of the
  // same base version — exactly the failure this test exists to catch: a sibling
  // workspace exact-pinning a different `-staging.<sha>` of the same `0.38.0` gets
  // deduped into this package's resolved `node_modules` entry, and both sides above
  // would still read "0.38.0" and pass. So separately, resolve the ACTUAL installed
  // package the same way Node/the bundler would from this package root, and compare
  // its full, un-stripped version against the full, un-stripped pin.
  const resolvedSdk = resolveInstalledPackageJson('@vectros-ai/sdk', PKG_ROOT);
  assert.equal(
    resolvedSdk.json.version,
    declaredSdkPin,
    `node_modules resolves @vectros-ai/sdk to ${resolvedSdk.json.version} (at ${resolvedSdk.path}) but ` +
      `package.json pins ${declaredSdkPin} exactly — a different prerelease BUILD of the same base ` +
      'version would pass the clean-base stamp checks above while bundling the wrong one.',
  );
});
