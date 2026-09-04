import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashObject, sha256 } from "../v2/fs.js";
import { observeWorkspaceAssets } from "./assets.js";

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "asset-observer-"))); roots.push(root);
  git(root, "init", "--quiet"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test");
  writeFileSync(join(root, ".gitignore"), "ignored/\n"); writeFileSync(join(root, "tracked"), "initial\n");
  git(root, "add", "."); git(root, "commit", "-qm", "initial"); return root;
}

it("binds staged bytes, dirty content, ignored/untracked files and symlinks without exposing or following content", () => {
  const root = fixture(); const clean = observeWorkspaceAssets(root); expect(clean.entries).toEqual([]);
  writeFileSync(join(root, "tracked"), "staged\n"); git(root, "add", "tracked"); writeFileSync(join(root, "tracked"), "secret-canary\n");
  writeFileSync(join(root, "untracked"), "keep\n"); mkdirSync(join(root, "ignored")); writeFileSync(join(root, "ignored", "keep"), "ignored-value\n");
  symlinkSync("/never-open-this-missing-target", join(root, "link"));
  const before = readFileSync(join(root, ".git", "index")); const observed = observeWorkspaceAssets(root);
  expect(observed.entries.map((entry) => [entry.path, entry.category, entry.kind])).toEqual([
    ["ignored/keep", "ignored", "file"], ["link", "untracked", "symlink"], ["tracked", "tracked", "file"], ["untracked", "untracked", "file"],
  ]);
  expect(observed.entries[2].sha256).toBe(sha256("secret-canary\n")); expect(JSON.stringify(observed)).not.toContain("secret-canary");
  expect(observed.indexHash).not.toBe(clean.indexHash); expect(readFileSync(join(root, ".git", "index"))).toEqual(before);
  writeFileSync(join(root, "tracked"), "changed same dirty path\n"); expect(hashObject(observeWorkspaceAssets(root))).not.toBe(hashObject(observed));
});

it("rejects hidden index state, filters and malformed Git configuration instead of reporting clean", () => {
  const root = fixture(); git(root, "update-index", "--assume-unchanged", "tracked");
  expect(() => observeWorkspaceAssets(root)).toThrow("WORKSPACE_ASSETS_UNSUPPORTED");
  git(root, "update-index", "--no-assume-unchanged", "tracked"); git(root, "config", "filter.fixture.clean", "must-never-run");
  expect(() => observeWorkspaceAssets(root)).toThrow("WORKSPACE_ASSETS_UNSUPPORTED");
  writeFileSync(join(root, ".git", "config"), "[invalid\n");
  expect(() => observeWorkspaceAssets(root)).toThrow("WORKSPACE_ASSET_OBSERVATION_FAILED");
});
