#!/usr/bin/env node
// Builds or refreshes this checkout's own CodeGraph index — `.codegraph/` at
// the checkout root, gitignored. Runs from `prepare`, so every `pnpm install`
// covers it: a fresh clone, the main checkout, and each new worktree (Step 2
// of `using-git-worktrees` installs dependencies there). Re-run by hand with:
//
//   pnpm run codegraph:setup
//
// Every checkout owns its index. Never copy or symlink another checkout's
// `.codegraph/`: CodeGraph resolves the nearest `.codegraph/` walking up, so a
// worktree nested under `.worktrees/` without its own index would silently
// answer from the main checkout's code.
//
// Checks the local `codegraph.db` file rather than `codegraph status` for the
// same reason — status can report a parent checkout's index. `init --yes`
// builds a missing index without prompts; an existing one (including one left
// by an interrupted init) needs `sync`.
//
// It also approves the project's `codegraph` MCP server for Claude Code.
// Claude Code ignores `enabledMcpjsonServers` in the shared
// `.claude/settings.json` (a cloned repo can't approve its own servers) and
// only honors it in the gitignored `.claude/settings.local.json` — the same
// entry its approval dialog writes. Running `pnpm install` already executes
// this repo's code, so approving the launcher it installs grants nothing new.
// An explicit rejection (`disabledMcpjsonServers`) is left alone.
//
// Best effort: indexing is an agent convenience, not part of the build, so a
// failure warns and still exits 0 instead of failing `pnpm install`. Skipped in
// CI, where no agent reads the index.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const aiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(aiRoot, '..');
const launcher = path.join(aiRoot, 'codegraph.mjs');
const database = path.join(repoRoot, '.codegraph', 'codegraph.db');
const claudeLocalSettings = path.join(repoRoot, '.claude', 'settings.local.json');

if (process.env.CI) {
  console.log('codegraph: skipped in CI');
  process.exit(0);
}

approveClaudeCodeServer();

const ready =
  (existsSync(database) || codegraph('init', '--yes', repoRoot)) &&
  existsSync(database) &&
  codegraph('sync', '--quiet', repoRoot);

if (!ready) {
  console.warn(
    'codegraph: setup failed — agents fall back to Read/Search in this checkout. ' +
      'Retry with `pnpm run codegraph:setup`.',
  );
}

function approveClaudeCodeServer() {
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(claudeLocalSettings, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(
        `codegraph: could not read ${claudeLocalSettings} (${error.message}) — ` +
          'approve the codegraph MCP server when Claude Code asks.',
      );
      return;
    }
  }

  const enabled = settings.enabledMcpjsonServers ?? [];
  if (enabled.includes('codegraph') || settings.disabledMcpjsonServers?.includes('codegraph')) {
    return;
  }

  mkdirSync(path.dirname(claudeLocalSettings), { recursive: true });
  writeFileSync(
    claudeLocalSettings,
    `${JSON.stringify({ ...settings, enabledMcpjsonServers: [...enabled, 'codegraph'] }, null, 2)}\n`,
  );
}

function codegraph(...args) {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  return result.status === 0;
}
