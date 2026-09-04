import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateCoordinationHistory } from "./history.js";

const roots: string[] = [];
const sha = (value: number) => value.toString(16).padStart(40, "0");
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const commonDir = mkdtempSync(join(tmpdir(), "harness-history-")); roots.push(commonDir);
  const reads: string[] = [];
  return { commonDir, reads, anchor: { validationVersion: "coordination-history/1" as const, genesisSha: sha(1), repository: "owner/repo", repositoryId: "42", controlRef: "refs/heads/control" },
    readValidatedCommit: (head: string) => { reads.push(head); const n = parseInt(head, 16); return { parents: n === 1 ? [] : [sha(n - 1)], treeSha: sha(n + 1_000) }; },
    isAncestor: (a: string, b: string) => parseInt(a, 16) <= parseInt(b, 16),
  };
}
it("resumes bounded cold verification, then only checks new commits; checkpoints never grant a lease", () => {
  const f = fixture();
  const run = (head = sha(6)) => validateCoordinationHistory({ ...f, head, batchSize: 2 });
  expect(run()).toEqual({ status: "pending", inspected: 2, verifiedTip: null });
  expect(run()).toEqual({ status: "pending", inspected: 2, verifiedTip: null });
  expect(run()).toEqual({ status: "verified", inspected: 1, verifiedTip: sha(6) });
  expect(f.reads).toEqual([sha(1), sha(6), sha(5), sha(4), sha(3), sha(2)]);
  expect(run()).toEqual({ status: "verified", inspected: 0, verifiedTip: sha(6) });
  expect(run(sha(7))).toEqual({ status: "verified", inspected: 1, verifiedTip: sha(7) });
  expect(() => run(sha(6))).toThrow("COORDINATION_HISTORY_DISCONTINUITY");
  const cold = fixture(); expect(validateCoordinationHistory({ ...cold, head: sha(7), batchSize: 10 }).inspected).toBe(6);
});
it("rejects project-parent genesis and a bad intermediate commit even when the newest tree is valid", () => {
  const f = fixture();
  expect(() => validateCoordinationHistory({ ...f, head: sha(6), readValidatedCommit: () => ({ parents: [sha(99)], treeSha: sha(100) }) })).toThrow("COORDINATION_HISTORY_GENESIS_INVALID");
  expect(() => validateCoordinationHistory({ ...f, head: sha(6), readValidatedCommit: (head) => { if (head === sha(3)) throw new Error("COORDINATION_RECORD_INVALID"); return f.readValidatedCommit(head); } })).toThrow("COORDINATION_RECORD_INVALID");
});
it("finishes its existing validation target when the remote advances, then validates the added segment", () => {
  const f = fixture();
  expect(validateCoordinationHistory({ ...f, head: sha(4), batchSize: 2 }).status).toBe("pending");
  expect(validateCoordinationHistory({ ...f, head: sha(6), batchSize: 2 })).toEqual({ status: "pending", verifiedTip: sha(4), inspected: 1 });
  expect(validateCoordinationHistory({ ...f, head: sha(6), batchSize: 2 })).toEqual({ status: "verified", verifiedTip: sha(6), inspected: 2 });
});
