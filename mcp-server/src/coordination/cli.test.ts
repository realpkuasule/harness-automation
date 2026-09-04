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
  it("rejects extra, duplicate, missing, forged-approval and arbitrary-command qualification arguments", () => {
    for (const args of [
      ["run", "--plan", "absent", "--approved", "true"], ["run", "--plan", "one", "--plan", "two"],
      ["run", "--plan"], ["plan", "--input", "absent", "extra"], ["run", "--plan", "absent", "--", "echo", "bad"],
      ["run", "--plan", "absent", "--provider", "fake"],
    ]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, "coordination", "qualification", ...args], { encoding: "utf8" });
      expect(result.status).toBe(1); expect(result.stderr).toContain("QUALIFICATION_ARGUMENTS_INVALID");
    }
  }, 30_000);
});
