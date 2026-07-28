#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = spawnSync("harness-automation", process.argv.slice(2), {
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(JSON.stringify({
    ok: false,
    error: `Unable to execute harness-automation: ${result.error.message}`,
    recovery: "Install the package globally or run the equivalent local dist/cli.js command.",
  }, null, 2));
  process.exit(1);
}

process.exit(result.status ?? 1);
