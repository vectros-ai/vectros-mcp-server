import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve the bundled @vectros-ai/sdk version to stamp into the binary
// (src/build-info.ts). Read package.json via fs, not `require('<pkg>/package.json')`
// — the SDK's `exports` map doesn't expose `./package.json`, so a subpath require
// throws ERR_PACKAGE_PATH_NOT_EXPORTED. fs sidesteps it.
const here = dirname(fileURLToPath(import.meta.url));
const readVersion = (...candidates: string[]): string => {
  for (const p of candidates) {
    try {
      return (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
    } catch {
      /* try next candidate */
    }
  }
  return 'unknown';
};
const ownVersion = readVersion(join(here, 'package.json'));
const depVersion = (name: string): string =>
  // Strip the `-staging.<sha>` prerelease suffix the staging build adds
  // (e.g. 0.29.5-staging.db5843ef). The PUBLISHED binary must report the clean
  // base version a consumer installs from public npm. The staging build is
  // byte-identical to the clean release of that base, so reporting the base is
  // accurate — and it keeps the staging build id out of the shipped dist +
  // sourcemaps.
  readVersion(
    join(here, 'node_modules', ...name.split('/'), 'package.json'), // member-local
    join(here, '..', '..', 'node_modules', ...name.split('/'), 'package.json'), // hoisted root
  ).replace(/-staging\..*$/, '');

/**
 * Dual ESM + CJS build with @vectros-ai/sdk inlined.
 *
 * The SDK is intentionally `devDependency`, not `dependency`. Reason:
 * pre-first-prod-release the SDK ships only to a private npm
 * registry. If `package.json` lists it as a runtime dep,
 * `npx -y @vectros-ai/mcp-server` on a partner's machine resolves it
 * against PUBLIC npm and 404s. Bundling the SDK source into the
 * compiled output makes the published package self-contained — no
 * runtime resolution of `@vectros-ai/sdk` needed, no `.npmrc`
 * required on the consumer's machine.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/cli-http.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
  splitting: false,
  // Bundle the SDK into our output (see header comment).
  noExternal: ['@vectros-ai/sdk'],
  // These stay external — installed by the user via `npm install` or
  // `npx -y @vectros-ai/mcp-server`.
  external: ['@modelcontextprotocol/sdk', 'zod', 'pino'],
  // Build-time provenance stamp — consumed by src/build-info.ts.
  define: {
    __MCP_VERSION__: JSON.stringify(ownVersion),
    __SDK_VERSION__: JSON.stringify(depVersion('@vectros-ai/sdk')),
  },
});
