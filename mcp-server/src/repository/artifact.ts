import { createRequire } from "node:module";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { atomicWrite, hashObject, prettyJson, sha256 } from "../v2/fs.js";
import { runGit } from "./git.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const harnessArtifactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), head: sha, tree: sha, artifactDigest: digest }).strict(),
  z.object({ kind: z.literal("package"), artifactDigest: digest }).strict(),
]);
export type HarnessArtifact = z.infer<typeof harnessArtifactSchema>;
const manifestSchema = z.object({ schemaVersion: z.literal("harness-runtime-manifest/1.0"), files: z.record(digest) }).strict();
const packageSchema = z.object({ name: z.string().min(1), version: z.string().min(1),
  dependencies: z.record(z.string()).optional(), optionalDependencies: z.record(z.string()).optional(),
  devDependencies: z.record(z.string()).optional(),
  peerDependencies: z.record(z.string()).optional(), peerDependenciesMeta: z.record(z.object({ optional: z.boolean().optional() })).optional(),
});
const manifestPath = "dist/runtime-manifest.json";
const moduleFile = fileURLToPath(import.meta.url);
const nativePackageRoot = realpathSync(join(dirname(moduleFile), "../.."));

function readPackage(root: string) {
  const file = join(root, "package.json");
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("HARNESS_PACKAGE_INVALID");
  const bytes = readFileSync(file); return { data: packageSchema.parse(JSON.parse(bytes.toString("utf8"))), hash: sha256(bytes) };
}
function runtimeFiles(root: string, mode: "source" | "package"): Record<string, string> {
  const result: Record<string, string> = {}; let totalBytes = 0; let fileCount = 0;
  const visit = (path: string) => {
    const stat = lstatSync(path); const key = relative(root, path).split("\\").join("/");
    if (stat.isSymbolicLink()) throw new Error("HARNESS_ARTIFACT_SYMLINK");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (["__fixtures__", "__tests__", ".DS_Store"].includes(name) || /(?:\.test\.[cm]?[jt]s|\.d\.ts|\.map)$/u.test(name)) continue;
        if (join(path, name) !== join(root, manifestPath)) visit(join(path, name));
      }
    } else {
      totalBytes += stat.size;
      if (!stat.isFile() || totalBytes > 128 * 1024 * 1024 || ++fileCount > 10_000) throw new Error("HARNESS_ARTIFACT_INVALID");
      result[key] = sha256(readFileSync(path));
    }
  };
  visit(join(root, "package.json")); visit(join(root, "postinstall.cjs")); visit(join(root, mode === "source" ? "src" : "dist"));
  return result;
}

/** Resolve package metadata without executing dependency code. Absolute install paths are not identities. */
function dependencyIdentities(root: string, mode: "source" | "package") {
  const visited = new Map<string, string>(); const nodes: Record<string, unknown> = {};
  const visit = (directory: string): string => {
    directory = realpathSync(directory); const cached = visited.get(directory); if (cached) return cached;
    if (visited.size >= 5_000) throw new Error("HARNESS_DEPENDENCY_GRAPH_LIMIT");
    const { data, hash } = readPackage(directory); const id = `${data.name}@${data.version}:${hash}`;
    visited.set(directory, id); const edges: Record<string, string | null> = {};
    const resolver = createRequire(join(directory, "package.json"));
    const dependencies = { ...(directory === root && mode === "source" ? data.devDependencies : {}), ...data.peerDependencies, ...data.dependencies, ...data.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/iu.test(name)) throw new Error("HARNESS_DEPENDENCY_INVALID");
      const optional = Object.hasOwn(data.optionalDependencies ?? {}, name) || data.peerDependenciesMeta?.[name]?.optional === true;
      // Node's package search order works for hidden exports and type-only packages without loading an entry.
      const dependency = resolver.resolve.paths(`${name}/package.json`)?.map((path) => join(path, name)).find((path) => lstatSync(join(path, "package.json"), { throwIfNoEntry: false }));
      if (!dependency) { if (optional) { edges[name] = null; continue; } throw new Error(`HARNESS_DEPENDENCY_MISSING: ${name}`); }
      if (readPackage(dependency).data.name !== name) throw new Error(`HARNESS_DEPENDENCY_INVALID: ${name}`);
      edges[name] = visit(dependency);
    }
    // Same manifest/version can have different resolved peers; retain each distinct dependency edge set.
    const graphId = hashObject({ id, edges }); nodes[graphId] = { id, edges }; return id;
  };
  return { root: visit(root), nodes };
}

/** Build output only. The manifest lists own runtime bytes; qualification also binds resolved dependency identities. */
export function writeRuntimeManifest(packageRoot: string): void {
  const root = realpathSync(packageRoot);
  const target = join(root, manifestPath);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("HARNESS_ARTIFACT_SYMLINK");
  atomicWrite(target, prettyJson({ schemaVersion: "harness-runtime-manifest/1.0", files: runtimeFiles(root, "package") }));
}

export function inspectHarnessArtifact(packageRoot: string, mode: "source" | "package"): HarnessArtifact {
  const root = realpathSync(packageRoot); const files = runtimeFiles(root, mode); const pkg = readPackage(root);
  if (pkg.data.name !== "@realpkuasule/harness-automation") throw new Error("HARNESS_PACKAGE_INVALID");
  if (mode === "package") {
    const path = join(root, manifestPath);
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || lstatSync(path).isSymbolicLink()) throw new Error("HARNESS_RUNTIME_MANIFEST_REQUIRED");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (hashObject(manifest.files) !== hashObject(files)) throw new Error("HARNESS_RUNTIME_MANIFEST_DRIFT");
  }
  const artifactDigest = hashObject({ files, dependencies: dependencyIdentities(root, mode), runtime: { node: process.version, platform: process.platform, arch: process.arch } });
  if (mode === "package") return { kind: "package", artifactDigest };
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  if (runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"], { env }).trim()) throw new Error("HARNESS_SOURCE_CHECKOUT_DIRTY");
  return harnessArtifactSchema.parse({ kind: "source", artifactDigest, head: runGit(root, ["rev-parse", "HEAD"], { env }).trim(), tree: runGit(root, ["rev-parse", "HEAD^{tree}"], { env }).trim() });
}

/** Native composition never accepts the target project's directory or a caller-supplied fingerprint. */
export function currentHarnessArtifact(): { implementation: HarnessArtifact; runnerHash: string } {
  const mode = moduleFile.endsWith(".ts") ? "source" : "package";
  return { implementation: inspectHarnessArtifact(nativePackageRoot, mode), runnerHash: sha256(readFileSync(join(nativePackageRoot, mode === "source" ? "src/cli.ts" : "dist/cli.js"))) };
}

if (process.argv[1] === moduleFile && process.argv[2] === "--write-manifest") writeRuntimeManifest(nativePackageRoot);
