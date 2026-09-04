import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { hashObject, safePath, sha256 } from "../v2/fs.js";
import { runGitCommand } from "./git.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const pathSchema = z.string().min(1).max(4096).refine((value) => !isAbsolute(value) &&
  !value.split("/").some((part) => !part || part === "." || part === "..") && !/[\x00-\x1f\x7f\ufffd\\]/u.test(value));
export const workspaceAssetsSchema = z.object({
  indexHash: digest,
  entries: z.array(z.object({ path: pathSchema, category: z.enum(["tracked", "untracked", "ignored"]),
    status: z.string().length(2), kind: z.enum(["file", "symlink", "missing"]), mode: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(), sha256: digest,
  }).strict()).max(4096),
}).strict();

/** No project filters, fsmonitor, ambient Git routing or optional index writes. */
export function inspectGit(root: string, args: string[], absentAllowed = false): string {
  const result = runGitCommand(root, ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  if (result.error || (result.status !== 0 && !(absentAllowed && result.status === 1))) throw new Error("WORKSPACE_ASSET_OBSERVATION_FAILED");
  return result.stdout;
}

export function assertInspectableWorkspace(root: string): string {
  const index = inspectGit(root, ["ls-files", "--stage", "-z"]);
  if (inspectGit(root, ["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], true) ||
      index.split("\0").some((line) => line.startsWith("160000 ")) ||
      inspectGit(root, ["ls-files", "-v", "-z"]).split("\0").some((line) => /^[a-zS]/u.test(line))) throw new Error("WORKSPACE_ASSETS_UNSUPPORTED");
  return index;
}

/** Content hashes only. Unsupported/oversized assets fail; they are never counted as absent. */
export function observeWorkspaceAssets(root: string): z.infer<typeof workspaceAssetsSchema> {
  const index = assertInspectableWorkspace(root);
  const entries: z.infer<typeof workspaceAssetsSchema>["entries"] = []; let total = 0;
  function add(path: string, status: string, category: typeof entries[number]["category"]) {
    pathSchema.parse(path);
    if (entries.length >= 4096) throw new Error("WORKSPACE_ASSET_LIMIT_EXCEEDED");
    const target = join(safePath(root, dirname(path)), basename(path)); // Terminal symlinks are hashed, never followed.
    const stat = lstatSync(target, { throwIfNoEntry: false });
    let kind: typeof entries[number]["kind"] = "missing"; let size = 0; let contentHash = sha256("");
    if (stat?.isSymbolicLink()) { kind = "symlink"; const link = readlinkSync(target); size = Buffer.byteLength(link); contentHash = sha256(link); }
    else if (stat) {
      if (!stat.isFile()) throw new Error("WORKSPACE_ASSETS_UNSUPPORTED");
      const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(descriptor);
        if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) throw new Error("WORKSPACE_ASSET_CHANGED");
        kind = "file"; const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let bytes: number;
        while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
          size += bytes;
          // ponytail: bounded synchronous inventory; use streaming resumable snapshots if real assets exceed 128 MiB.
          if (total + size > 128 * 1024 * 1024) throw new Error("WORKSPACE_ASSET_LIMIT_EXCEEDED");
          hash.update(buffer.subarray(0, bytes));
        }
        const after = fstatSync(descriptor);
        if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("WORKSPACE_ASSET_CHANGED");
        contentHash = hash.digest("hex");
      } finally { closeSync(descriptor); }
    }
    total += size; entries.push({ path, category, status, kind, mode: stat ? stat.mode & 0o777 : 0, size, sha256: contentHash });
  }
  const status = inspectGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  const tokens = status.split("\0"); if (tokens.pop() !== "") throw new Error("WORKSPACE_ASSET_OBSERVATION_FAILED");
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].length < 4 || tokens[i][2] !== " ") throw new Error("WORKSPACE_ASSET_OBSERVATION_FAILED");
    const state = tokens[i].slice(0, 2); add(tokens[i].slice(3), state, state === "??" ? "untracked" : "tracked");
    if (/[RC]/u.test(state)) { if (!tokens[++i]) throw new Error("WORKSPACE_ASSET_OBSERVATION_FAILED"); pathSchema.parse(tokens[i]); }
  }
  const ignored = inspectGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0");
  if (ignored.pop() !== "") throw new Error("WORKSPACE_ASSET_OBSERVATION_FAILED");
  for (const path of ignored) add(path, "!!", "ignored");
  if (inspectGit(root, ["ls-files", "--stage", "-z"]) !== index ||
      inspectGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]) !== status) throw new Error("WORKSPACE_ASSET_CHANGED");
  return workspaceAssetsSchema.parse({ indexHash: hashObject(index), entries: entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}
