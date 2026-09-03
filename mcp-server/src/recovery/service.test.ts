import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWrite, hashObject, prettyJson, sha256 } from "../v2/fs.js";
import { appendReceiptEvent } from "../receipt/service.js";
import {
  acquireMutationLock,
  createFileApplyJournal,
  createRecoveryApproval,
  inspectRecoveryState,
  recordRecoveryApproval,
  releaseMutationLock,
  requireMutationAllowed,
  requireSafeModeCommand,
} from "./service.js";

const roots: string[] = [];

function context() {
  const projectDir = mkdtempSync(join(tmpdir(), "harness-recovery-"));
  roots.push(projectDir);
  return { projectDir, commonDir: projectDir, repository: false };
}

function writeJournal(root: string, id: string, paths = ["generated.txt"]) {
  const operations = paths.map((path) => ({ path, beforeHash: null, afterHash: sha256(`after:${path}`) }));
  const journal = createFileApplyJournal({
    recoveryId: randomUUID(), planHash: sha256(`plan:${id}`), operations,
    status: "started", written: [paths[0]],
  });
  atomicWrite(join(root, ".harness", "changes", id, "apply.json"), prettyJson(journal));
  return journal;
}

function approve(ctx: ReturnType<typeof context>, id: string, now = new Date("2026-01-01T00:00:00.000Z")) {
  const finding = inspectRecoveryState(ctx).find((item) => item.id === id)!;
  const approval = createRecoveryApproval({
    context: ctx,
    finding,
    approvedBy: "owner",
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  recordRecoveryApproval(ctx, approval);
  return approval;
}

describe("recovery safe mode", () => {
  it("uses one shared mutation lock and rejects unapproved recovery", () => {
    const ctx = context();
    const lock = acquireMutationLock(ctx);
    expect(() => acquireMutationLock(ctx)).toThrow("WORKSPACE_LOCKED");
    releaseMutationLock(lock);

    writeJournal(ctx.projectDir, "change-one");
    expect(() => requireSafeModeCommand("apply")).toThrow("SAFE_MODE_MUTATION_REJECTED");
    expect(() => requireMutationAllowed(ctx)).toThrow("RECOVERY_REQUIRED");
    expect(() => requireMutationAllowed(ctx, { kind: "file-apply", id: "change-one", action: "resume-apply" }))
      .toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");

    const approval = approve(ctx, "change-one");
    expect(approval).toMatchObject({
      schemaVersion: "recovery-approval/2.0",
      action: "resume-apply",
      evidenceHash: inspectRecoveryState(ctx)[0].evidenceHash,
    });
    expect(() => requireMutationAllowed(ctx, {
      kind: "file-apply", id: "change-one", action: "resume-apply", approvalRef: approval.id,
      now: new Date("2026-01-01T00:00:30.000Z"),
    })).not.toThrow();
    expect(() => requireMutationAllowed(ctx, {
      kind: "file-apply", id: "change-one", action: "resume-apply", approvalRef: approval.id,
      now: new Date("2026-01-01T00:02:00.000Z"),
    })).toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  });

  it("recovers one exact target even when another transaction is also pending", () => {
    const ctx = context();
    writeJournal(ctx.projectDir, "change-one");
    writeJournal(ctx.projectDir, "change-two");
    const approval = approve(ctx, "change-one");
    expect(inspectRecoveryState(ctx)).toHaveLength(2);
    expect(() => requireMutationAllowed(ctx, {
      kind: "file-apply", id: "change-one", action: "resume-apply", approvalRef: approval.id,
      now: new Date("2026-01-01T00:00:30.000Z"),
    })).not.toThrow();
    expect(() => requireMutationAllowed(ctx, {
      kind: "file-apply", id: "change-two", action: "resume-apply", approvalRef: approval.id,
      now: new Date("2026-01-01T00:00:30.000Z"),
    })).toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  });

  it("invalidates approval when current recovery evidence changes", () => {
    const ctx = context();
    const journal = writeJournal(ctx.projectDir, "change-one");
    const approval = approve(ctx, "change-one");
    const changed = createFileApplyJournal({
      recoveryId: journal.recoveryId,
      planHash: journal.planHash,
      operations: journal.operations,
      status: "failed-uncompensated",
      written: journal.written,
    });
    atomicWrite(join(ctx.projectDir, ".harness", "changes", "change-one", "apply.json"), prettyJson(changed));
    expect(() => requireMutationAllowed(ctx, {
      kind: "file-apply", id: "change-one", action: "resume-apply", approvalRef: approval.id,
      now: new Date("2026-01-01T00:00:30.000Z"),
    })).toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  });

  it("requires a complete matching change receipt before ignoring a leftover apply journal", () => {
    const ctx = context();
    const journal = writeJournal(ctx.projectDir, "change-one", ["one.txt", "two.txt"]);
    for (const operation of journal.operations) {
      writeFileSync(join(ctx.projectDir, operation.path), `after:${operation.path}`);
    }
    atomicWrite(join(ctx.projectDir, ".harness", "changes", "change-one", "change.json"), prettyJson({
      planHash: journal.planHash,
      operations: journal.operations.slice(0, 1),
    }));
    expect(inspectRecoveryState(ctx)).toMatchObject([{ kind: "file-apply", id: "change-one" }]);
    atomicWrite(join(ctx.projectDir, ".harness", "changes", "change-one", "change.json"), prettyJson({
      planHash: journal.planHash,
      operations: journal.operations,
    }));
    expect(inspectRecoveryState(ctx)).toEqual([]);
  });

  it("trusts only strict workspace receipts and never hides failed compensation", () => {
    const ctx = context();
    const receipts = join(ctx.commonDir, "harness", "worktree-delivery", "receipts");
    mkdirSync(receipts, { recursive: true });
    const base = {
      schemaVersion: "worktree-delivery/1.0",
      kind: "workspace-receipt",
      id: "worktree-configure-2026-01-01T00-00-00-000Z-aaaaaaaaaaaa",
      planHash: "a".repeat(64),
      operation: "configure",
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      steps: [{ id: "write", status: "applied", detail: "config" }],
      before: { observedHash: "b".repeat(64) },
      beforeObservedHash: "b".repeat(64),
      mutationStarted: true,
      compensationStatus: "completed",
      compensationObservedHash: "b".repeat(64),
    };
    writeFileSync(join(receipts, `${base.id}.json`), JSON.stringify(base));
    expect(inspectRecoveryState(ctx)).toEqual([]);

    writeFileSync(join(receipts, `${base.id}.json`), JSON.stringify({
      ...base, status: "applied", compensationStatus: "failed",
    }));
    expect(inspectRecoveryState(ctx)).toMatchObject([{ kind: "workspace", id: base.id }]);

    const malformedId = "worktree-configure-2026-01-01T00-00-01-000Z-bbbbbbbbbbbb";
    writeFileSync(join(receipts, `${malformedId}.json`), JSON.stringify({ status: "applied" }));
    expect(inspectRecoveryState(ctx).some((finding) => finding.kind === "invalid" && finding.id === malformedId)).toBe(true);
  });

  it("does not treat unrelated legacy delivery receipts as workspace transactions", () => {
    const ctx = context();
    const receipts = join(ctx.commonDir, "harness", "worktree-delivery", "receipts");
    mkdirSync(receipts, { recursive: true });
    writeFileSync(join(receipts, "delivery-push-legacy.json"), "{}", "utf8");
    expect(inspectRecoveryState(ctx)).toEqual([]);
  });

  it("detects journal tampering", () => {
    const ctx = context();
    const journal = writeJournal(ctx.projectDir, "change-one");
    const path = join(ctx.projectDir, ".harness", "changes", "change-one", "apply.json");
    writeFileSync(path, prettyJson({ ...journal, written: ["other.txt"], journalHash: hashObject(journal) }));
    expect(inspectRecoveryState(ctx)).toMatchObject([{ kind: "invalid", id: "change-one" }]);
  });

  it("fails closed when an immutable workspace receipt chain is tampered", () => {
    const ctx = context();
    const id = "worktree-configure-2026-01-01T00-00-00-000Z-aaaaaaaaaaaa";
    appendReceiptEvent({
      root: ctx.commonDir,
      domain: "workspace",
      transactionId: id,
      snapshot: {
        schemaVersion: "worktree-delivery/1.0",
        kind: "workspace-receipt",
        id,
        planHash: "a".repeat(64),
        operation: "configure",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
        steps: [],
        before: { observedHash: "b".repeat(64) },
        beforeObservedHash: "b".repeat(64),
        mutationStarted: false,
        compensationStatus: "not-required",
      },
    });
    writeFileSync(join(
      ctx.commonDir, "harness", "receipts", "workspace", id, "events", "000000000001.json",
    ), "{}", "utf8");
    expect(inspectRecoveryState(ctx)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invalid", id }),
    ]));
  });
});

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
