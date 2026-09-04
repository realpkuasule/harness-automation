import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectHarnessArtifact, writeRuntimeManifest } from "./artifact.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-artifact-")); roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@realpkuasule/harness-automation", version: "0.0.0", dependencies: { "fixture-dep": "1.0.0" } }));
  writeFileSync(join(root, "postinstall.cjs"), "// fixture\n");
  for (const directory of ["src", "dist", "node_modules/fixture-dep"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "src/cli.ts"), "export {};\n"); writeFileSync(join(root, "dist/cli.js"), "export {};\n");
  writeFileSync(join(root, "node_modules/fixture-dep/package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(root, "node_modules/fixture-dep/index.js"), `require('node:fs').writeFileSync(${JSON.stringify(join(root, "EXECUTED"))},'bad');\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n");
  return root;
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
}

it("verifies installed runtime bytes without any Git checkout or dependency execution", () => {
  const root = fixture();
  expect(() => inspectHarnessArtifact(root, "package")).toThrow("HARNESS_RUNTIME_MANIFEST_REQUIRED");
  writeRuntimeManifest(root); const before = inspectHarnessArtifact(root, "package");
  expect(before.kind).toBe("package"); expect(before).not.toHaveProperty("head"); expect(existsSync(join(root, "EXECUTED"))).toBe(false);
  const original = readFileSync(join(root, "dist/cli.js"));
  writeFileSync(join(root, "dist/cli.js"), "// changed bytes\n");
  expect(() => inspectHarnessArtifact(root, "package")).toThrow("HARNESS_RUNTIME_MANIFEST_DRIFT");
  writeFileSync(join(root, "dist/cli.js"), original); writeFileSync(join(root, "dist/unexpected.js"), "export {};\n");
  expect(() => inspectHarnessArtifact(root, "package")).toThrow("HARNESS_RUNTIME_MANIFEST_DRIFT"); rmSync(join(root, "dist/unexpected.js"));
  writeFileSync(join(root, "node_modules/fixture-dep/package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.1" }));
  // An install's current digest can be measured, but it cannot match the prior qualification binding.
  expect(inspectHarnessArtifact(root, "package").artifactDigest).not.toBe(before.artifactDigest);
  rmSync(join(root, "dist/cli.js")); expect(() => inspectHarnessArtifact(root, "package")).toThrow("HARNESS_RUNTIME_MANIFEST_DRIFT");
});

it("uses the Harness source checkout itself, rejects dirty code and never trusts a caller's head string", () => {
  const root = fixture(); git(root, "init", "--quiet"); git(root, "add", "."); git(root, "commit", "--quiet", "-m", "fixture");
  const result = inspectHarnessArtifact(root, "source");
  expect(result).toMatchObject({ kind: "source", head: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") });
  writeFileSync(join(root, "src/cli.ts"), "// dirty\n");
  expect(() => inspectHarnessArtifact(root, "source")).toThrow("HARNESS_SOURCE_CHECKOUT_DIRTY");
});

it("rejects runtime links and excludes files npm omits from the executable manifest", () => {
  const root = fixture();
  writeFileSync(join(root, "dist/cli.test.js"), "// unpublished fixture\n"); writeFileSync(join(root, "dist/cli.js.map"), "{}");
  writeRuntimeManifest(root); const original = inspectHarnessArtifact(root, "package");
  rmSync(join(root, "dist/cli.test.js")); rmSync(join(root, "dist/cli.js.map"));
  expect(inspectHarnessArtifact(root, "package")).toEqual(original);
  symlinkSync(join(root, "src/cli.ts"), join(root, "dist/link.js"));
  expect(() => inspectHarnessArtifact(root, "package")).toThrow("HARNESS_ARTIFACT_SYMLINK");
});

it.each([false, true])("resolves an ESM type-only package boundary without executing it (metadata export: %s)", (metadataExport) => {
  const root = fixture(); const dependency = join(root, "node_modules/fixture-dep");
  mkdirSync(join(dependency, "esm"));
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", exports: { ".": "./esm/index.js", ...(metadataExport ? { "./package.json": "./esm/package.json" } : {}) } }));
  writeFileSync(join(dependency, "esm/package.json"), '{"type":"module"}');
  writeFileSync(join(dependency, "esm/index.js"), "throw new Error('must not execute');\n");
  writeRuntimeManifest(root);
  expect(inspectHarnessArtifact(root, "package").kind).toBe("package");
});

it("includes installed type-only dependencies whose exports provide no runtime entry", () => {
  const root = fixture();
  writeFileSync(join(root, "node_modules/fixture-dep/package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", exports: { types: "./index.d.ts" } }));
  writeRuntimeManifest(root);
  expect(inspectHarnessArtifact(root, "package").kind).toBe("package");
});

it("does not confuse a declared npm dependency with a same-named Node built-in", () => {
  const root = fixture(); const dependency = join(root, "node_modules/punycode"); mkdirSync(dependency);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@realpkuasule/harness-automation", version: "0.0.0", dependencies: { punycode: "2.0.0" } }));
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "punycode", version: "2.0.0" }));
  writeRuntimeManifest(root); expect(inspectHarnessArtifact(root, "package").kind).toBe("package");
});
