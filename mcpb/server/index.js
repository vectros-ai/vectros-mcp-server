#!/usr/bin/env node
/**
 * Vectros MCP — Claude Desktop Extension launcher (the `.mcpb` entry point).
 *
 * Claude Desktop runs this file; it execs the published
 * `@vectros-ai/mcp-server` over stdio via `npx`, so the extension always
 * launches the latest published server without bundling a pinned copy. The
 * API key arrives in the environment as `VECTROS_API_KEY`, injected by Claude
 * Desktop from the extension's user-config field (see manifest.json).
 *
 * Plain CommonJS + Node built-ins only — no install step inside the bundle.
 */
const { spawn } = require('node:child_process');

const child = spawn('npx', ['-y', '@vectros-ai/mcp-server'], {
  stdio: 'inherit',
  env: process.env,
  // On Windows `npx` is a .cmd shim, which requires a shell to resolve.
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on('error', (err) => {
  process.stderr.write(
    `vectros: failed to launch @vectros-ai/mcp-server via npx (${err.message}). ` +
      'Ensure Node.js 20+ is available.\n',
  );
  process.exit(1);
});
