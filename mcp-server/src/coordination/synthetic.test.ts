import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { approvedSyntheticPublication, prepareSyntheticObject, syntheticObjectSchema, syntheticScopeSchema, validateSourceFixtureGraph } from "./synthetic.js";

const metadata = { runId: "bounded-run", objectId: "genesis", seconds: 1788480000 };
it("precomputes exact Git bytes without creating commit objects or taking execution-time metadata", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "synthetic-plan-")));
  try {
    execFileSync("git", ["init", "--bare", "--quiet", "--template=", directory]);
    const before = readdirSync(join(directory, "objects"));
    const plan = prepareSyntheticObject("control-genesis", metadata);
    const git = spawnSync("git", ["hash-object", "-t", "commit", "--stdin"], { cwd: directory, input: plan.commitText, encoding: "utf8" });
    expect(git.status).toBe(0); expect(git.stdout.trim()).toBe(plan.commitSha); expect(readdirSync(join(directory, "objects"))).toEqual(before);
    expect(spawnSync("git", ["cat-file", "-e", plan.commitSha], { cwd: directory, stdio: "ignore" }).status).not.toBe(0);
    expect(prepareSyntheticObject("control-genesis", metadata)).toEqual(plan);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("rejects arbitrary payload, headers, hash drift and source/control ancestry confusion", () => {
  const genesis = prepareSyntheticObject("control-genesis", metadata);
  for (const patch of [{ commitText: `${genesis.commitText}arbitrary payload` }, { treeSha: "a".repeat(40) }, { objectFormat: "sha256" }, { parents: ["a".repeat(40)] }]) {
    expect(syntheticObjectSchema.safeParse({ ...genesis, ...patch }).success).toBe(false);
  }
  expect(() => prepareSyntheticObject("control-genesis", { ...metadata, objectId: "header\nextra" })).toThrow();
  const first = prepareSyntheticObject("source-fixture", { ...metadata, objectId: "source-root" });
  const next = prepareSyntheticObject("source-fixture", { ...metadata, objectId: "source-next" }, [first.commitSha]);
  expect(validateSourceFixtureGraph([next, first])).toEqual([next, first]);
  expect(() => validateSourceFixtureGraph([next])).toThrow("SYNTHETIC_SOURCE_GRAPH_INVALID");
  const wrong = prepareSyntheticObject("source-fixture", { ...metadata, objectId: "wrong" }, [genesis.commitSha]);
  expect(() => validateSourceFixtureGraph([wrong, genesis])).toThrow("SYNTHETIC_SOURCE_GRAPH_INVALID");
  expect(() => validateSourceFixtureGraph([first, first])).toThrow("SYNTHETIC_SOURCE_GRAPH_INVALID");
});

it("keeps read-only graph entries separate from exact publication rights", () => {
  const genesis = prepareSyntheticObject("control-genesis", metadata);
  const source = prepareSyntheticObject("source-fixture", { ...metadata, objectId: "source-root" });
  const next = prepareSyntheticObject("source-fixture", { ...metadata, objectId: "source-next" }, [source.commitSha]);
  const publication = { fixtureId: next.metadata.objectId, transactionId: "source-update", ref: "refs/heads/source", expected: source.commitSha };
  const scope = { objects: [genesis, source, next], controls: [{ fixtureId: genesis.metadata.objectId, ref: "refs/heads/control" }], publications: [publication] };
  expect(approvedSyntheticPublication(scope, next.metadata.objectId)).toEqual({ plan: next, publication });
  expect(() => approvedSyntheticPublication(scope, source.metadata.objectId)).toThrow("HUMAN_SYNTHETIC_SCOPE_REQUIRED");
  for (const changed of [
    { ...scope, publications: [publication, publication] },
    { ...scope, publications: [{ ...publication, expected: genesis.commitSha }] },
    { ...scope, publications: [publication, { fixtureId: genesis.metadata.objectId, transactionId: "bootstrap", ref: publication.ref, expected: null }] },
    { ...scope, objects: [genesis, next] },
  ]) expect(syntheticScopeSchema.safeParse(changed).success).toBe(false);
});
