import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticObjectSchema, type SyntheticObjectPlan } from "./synthetic.js";

export const objectEnv = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
export function objectGit(directory: string, argv: string[], input?: string, commitDate?: string): string {
  const result = spawnSync("git", ["--no-replace-objects", ...argv], { cwd: directory, env: { ...objectEnv(), ...(commitDate ? { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate } : {}) }, input, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("ENVIRONMENT_BLOCKED: GIT_UNAVAILABLE");
  if (result.error || result.status !== 0) throw new Error("COORDINATION_OBJECT_READ_FAILED");
  return result.stdout;
}

/** Owned bare object storage: no project config, alternates, checkout, filters or hooks. */
export function objectDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-coordination-objects-")));
  try { objectGit(directory, ["init", "--bare", "--quiet", "--template=", "--object-format=sha1"]); return directory; }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function validateSyntheticObject(directory: string, input: SyntheticObjectPlan): void {
  const plan = syntheticObjectSchema.parse(input);
  if (objectGit(directory, ["cat-file", "commit", plan.commitSha]) !== plan.commitText ||
      objectGit(directory, ["cat-file", "tree", plan.treeSha]) !== "") throw new Error("SYNTHETIC_OBJECT_MISMATCH");
}
