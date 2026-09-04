import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const cli = resolve("src/cli.ts");
function invoke(root: string, action: string) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, "coordination", action, "--project", root], { cwd: resolve("."), encoding: "utf8" });
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("coordination CLI", () => {
  it("routes status and rejects every unconfigured mutation before transport", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-coordination-cli-")); roots.push(root);
    const status = invoke(root, "status");
    expect(status.status).toBe(0); expect(JSON.parse(status.stdout)).toMatchObject({ configured: false, result: "CoordinationBackendRequired" });
    const mutation = invoke(root, "renew");
    expect(mutation.status).not.toBe(0); expect(mutation.stderr).toContain("CoordinationBackendRequired");
  });
});
