import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireMutationLock, assertMutationLock, releaseMutationLock, relocateMutationLock, withMutationLock, type MutationLock } from "./service.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mutation-lock-"))); roots.push(root);
  const projectDir = join(root, "project"); mkdirSync(projectDir); const commonDir = join(projectDir, ".git"); mkdirSync(commonDir);
  return { root, context: { projectDir, commonDir, repository: true }, path: join(commonDir, "harness/worktree-delivery/apply.lock") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("rejects forged, cross-domain and released handles without deleting a successor", () => {
  const f = fixture(); const other = fixture(); const held = acquireMutationLock(f.context);
  assertMutationLock(f.context, held);
  for (const fake of [{}, JSON.parse(JSON.stringify(held)), f.path]) expect(() => assertMutationLock(f.context, fake as MutationLock)).toThrow("MUTATION_LOCK_NOT_HELD");
  expect(() => assertMutationLock(other.context, held)).toThrow("MUTATION_LOCK_CONTEXT_MISMATCH");
  expect(() => acquireMutationLock(f.context)).toThrow("WORKSPACE_LOCKED");
  releaseMutationLock(held); const successor = acquireMutationLock(f.context);
  expect(() => releaseMutationLock(held)).toThrow("MUTATION_LOCK_NOT_HELD");
  assertMutationLock(f.context, successor); releaseMutationLock(successor);
});

it("another process cannot borrow a serialized handle or acquire the occupied path", () => {
  const f = fixture(); const held = acquireMutationLock(f.context);
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import{acquireMutationLock,assertMutationLock}from ${JSON.stringify(new URL("./service.ts", import.meta.url).href)};
     const c=JSON.parse(process.argv[1]);let failures=[];
     try{assertMutationLock(c,JSON.parse(process.argv[2]))}catch(e){failures.push(e.message)}
     try{acquireMutationLock(c)}catch(e){failures.push(e.message.split(':')[0])}
     process.stdout.write(JSON.stringify(failures));`, JSON.stringify(f.context), JSON.stringify(held)], { encoding: "utf8" });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual(["MUTATION_LOCK_NOT_HELD", "WORKSPACE_LOCKED"]);
  releaseMutationLock(held);
});

it("does not release while the awaited writer is active, including exceptional completion", async () => {
  const f = fixture(); let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
  const run = withMutationLock(f.context, async (held) => { await pending; assertMutationLock(f.context, held); throw new Error("writer-failed"); });
  expect(() => acquireMutationLock(f.context)).toThrow("WORKSPACE_LOCKED");
  finish(); await expect(run).rejects.toThrow("writer-failed");
  const next = acquireMutationLock(f.context); releaseMutationLock(next);
});

it("keeps a replaced owner marker and reports both operation and cleanup errors", async () => {
  const f = fixture();
  await expect(withMutationLock(f.context, () => { writeFileSync(join(f.path, "owner"), "replacement"); throw new Error("operation-failed"); }))
    .rejects.toMatchObject({ message: "MUTATION_AND_RELEASE_FAILED", errors: [expect.objectContaining({ message: "operation-failed" }), expect.objectContaining({ message: "MUTATION_LOCK_LOST" })] });
  expect(existsSync(f.path)).toBe(true);
});

it("relocates only the same directory under the exact checkout move and invalidates the old handle", () => {
  const f = fixture(); const old = acquireMutationLock(f.context); const moved = join(f.root, "moved"); renameSync(f.context.projectDir, moved);
  const context = { projectDir: moved, commonDir: join(moved, ".git"), repository: true };
  expect(() => relocateMutationLock(old, { from: join(f.root, "wrong"), to: moved, context })).toThrow("MUTATION_LOCK_RELOCATION_INVALID");
  const held = relocateMutationLock(old, { from: f.context.projectDir, to: moved, context });
  expect(() => releaseMutationLock(old)).toThrow("MUTATION_LOCK_NOT_HELD");
  assertMutationLock(context, held); expect(() => acquireMutationLock(context)).toThrow("WORKSPACE_LOCKED"); releaseMutationLock(held);
});

it("refuses a replaced directory or missing owner marker without removing it", () => {
  const f = fixture(); const held = acquireMutationLock(f.context);
  renameSync(f.path, `${f.path}.original`); mkdirSync(f.path);
  expect(() => releaseMutationLock(held)).toThrow("MUTATION_LOCK_LOST"); expect(existsSync(f.path)).toBe(true);
});
