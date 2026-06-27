# Vectros Claude Desktop Extension (`.mcpb`)

This directory is the source for the Vectros **Desktop Extension** — a one-click
install for [Claude Desktop](https://claude.ai/download). Instead of editing
`claude_desktop_config.json` by hand, a user double-clicks (or drags in) a
`.mcpb` bundle and pastes their key into a form field.

## What's here

- [`manifest.json`](./manifest.json) — the extension manifest
  ([MCPB spec](https://github.com/anthropics/mcpb), `manifest_version` 0.3). It
  declares the server, the 21 tools, and a single **sensitive** user-config
  field for `VECTROS_API_KEY`.
- [`server/index.js`](./server/index.js) — a tiny launcher Claude Desktop runs.
  It execs the published `@vectros-ai/mcp-server` over stdio via `npx`, so the
  extension always launches the latest published server (nothing is pinned or
  bundled). The key is passed through the environment.

## Honest note on the key

The extension does **not** provision a credential — there is no unattended
signup. The key field's help text points at `npx -y @vectros-ai/cli bootstrap`,
which mints a least-privilege scoped key (`ssk_...`) after a one-time
developer-portal sign-in. The extension only injects a key you already have.

## Building the bundle

Release CI builds and attaches this automatically: the
`publish-mcpb-release` workflow packs the bundle under the **stable name**
`vectros.mcpb` and attaches it to the GitHub Release on each version bump, so the
one-click badge `…/releases/latest/download/vectros.mcpb` always resolves to the
newest build. The bundle is a release artifact, not a checked-in binary.

To build it by hand (e.g. local testing), run from the package root:

```sh
npx -y @anthropic-ai/mcpb pack mcpb vectros.mcpb
```

This validates `manifest.json` against the MCPB schema and produces
`vectros.mcpb`.
