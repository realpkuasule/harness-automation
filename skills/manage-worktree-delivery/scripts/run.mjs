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
    recovery: "Install @realpkuasule/harness-automation globally, then retry.",
  }, null, 2));
  process.exit(1);
}

process.exit(result.status ?? 1);
