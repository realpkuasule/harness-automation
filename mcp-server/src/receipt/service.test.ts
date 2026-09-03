import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWrite, durableWriteOnce, hashObject, prettyJson, readJson } from "../v2/fs.js";
import {
  appendLkgRecord,
  appendReceiptEvent,
  readLatestLkgRecord,
  readLatestReceiptEvent,
  readLkgChain,
  readReceiptChain,
  type ReceiptEvent,
} from "./service.js";

const roots: string[] = [];
const digest = (value: string): string => value.repeat(64);

function root(): string {
  const path = join(tmpdir(), `harness-receipt-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

function eventPath(base: string, transactionId: string, sequence: number): string {
  return join(base, "harness", "receipts", "workspace", transactionId, "events", `${String(sequence).padStart(12, "0")}.json`);
}

function withoutEventHash(event: ReceiptEvent): Omit<ReceiptEvent, "eventHash"> {
  const copy: Partial<ReceiptEvent> = { ...event };
  delete copy.eventHash;
  return copy as Omit<ReceiptEvent, "eventHash">;
}

describe("append-only receipt events", () => {
  it("appends a strict hash chain and treats the same snapshot as idempotent", () => {
    const base = root();
    const first = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "change-1", snapshot: { status: "started" } });
    const duplicate = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "change-1", snapshot: { status: "started" } });
    const second = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "change-1", snapshot: { status: "failed" } });
    const reentered = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "change-1", snapshot: { status: "started" } });
    const reenteredDuplicate = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "change-1", snapshot: { status: "started" } });

    expect(duplicate).toEqual(first);
    expect(second.sequence).toBe(2);
    expect(second.previousEventHash).toBe(first.eventHash);
    expect(reentered.sequence).toBe(3);
    expect(reenteredDuplicate).toEqual(reentered);
    expect(readLatestReceiptEvent({ root: base, domain: "workspace", transactionId: "change-1" })?.eventHash).toBe(reentered.eventHash);
    expect(readReceiptChain({ root: base, domain: "workspace", transactionId: "change-1" })).toHaveLength(3);
  });

  it("anchors a legacy projection, accepts only exact lag, and repairs lag or absence", () => {
    const base = root();
    const projection = { root: base, path: "compat/change.json" };
    const projectionPath = join(base, projection.path);
    const started = { status: "started", steps: [] as string[] };
    const applied = { status: "applied", steps: ["write"] };
    atomicWrite(projectionPath, prettyJson(started));

    const latest = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "legacy-1", snapshot: applied, projection });
    expect(latest.sequence).toBe(2);
    expect(readReceiptChain({ root: base, domain: "workspace", transactionId: "legacy-1", compatibilitySnapshot: started })).toHaveLength(2);
    expect(readJson(projectionPath)).toEqual(applied);

    atomicWrite(projectionPath, prettyJson(started));
    expect(appendReceiptEvent({ root: base, domain: "workspace", transactionId: "legacy-1", snapshot: applied, projection }).sequence).toBe(2);
    expect(readJson(projectionPath)).toEqual(applied);
    rmSync(projectionPath);
    expect(appendReceiptEvent({ root: base, domain: "workspace", transactionId: "legacy-1", snapshot: applied, projection }).sequence).toBe(2);
    expect(readJson(projectionPath)).toEqual(applied);
    expect(readdirSync(dirname(eventPath(base, "legacy-1", 1)))).toHaveLength(2);

    atomicWrite(projectionPath, prettyJson({ status: "unknown" }));
    expect(() => appendReceiptEvent({ root: base, domain: "workspace", transactionId: "legacy-1", snapshot: applied, projection }))
      .toThrow("RECEIPT_PROJECTION_DIVERGED");
  });

  it("rejects gaps, unexpected names, broken links, snapshot/hash tampering, and symlinks", () => {
    const gapRoot = root();
    for (const status of ["started", "writing", "applied"]) {
      appendReceiptEvent({ root: gapRoot, domain: "workspace", transactionId: "gap", snapshot: { status } });
    }
    rmSync(eventPath(gapRoot, "gap", 2));
    expect(() => readReceiptChain({ root: gapRoot, domain: "workspace", transactionId: "gap" })).toThrow("RECEIPT_CHAIN_TAMPERED");

    const nameRoot = root();
    appendReceiptEvent({ root: nameRoot, domain: "workspace", transactionId: "name", snapshot: { status: "started" } });
    writeFileSync(join(dirname(eventPath(nameRoot, "name", 1)), "other.json"), "{}\n");
    expect(() => readReceiptChain({ root: nameRoot, domain: "workspace", transactionId: "name" })).toThrow("RECEIPT_CHAIN_TAMPERED");

    const snapshotRoot = root();
    appendReceiptEvent({ root: snapshotRoot, domain: "workspace", transactionId: "snapshot", snapshot: { status: "started" } });
    const snapshotEvent = readJson<ReceiptEvent>(eventPath(snapshotRoot, "snapshot", 1));
    snapshotEvent.snapshot = { status: "tampered" };
    atomicWrite(eventPath(snapshotRoot, "snapshot", 1), prettyJson(snapshotEvent));
    expect(() => readReceiptChain({ root: snapshotRoot, domain: "workspace", transactionId: "snapshot" })).toThrow("RECEIPT_CHAIN_TAMPERED");

    const hashRoot = root();
    appendReceiptEvent({ root: hashRoot, domain: "workspace", transactionId: "hash", snapshot: { status: "started" } });
    const hashEvent = readJson<ReceiptEvent>(eventPath(hashRoot, "hash", 1));
    hashEvent.eventHash = digest("f");
    atomicWrite(eventPath(hashRoot, "hash", 1), prettyJson(hashEvent));
    expect(() => readReceiptChain({ root: hashRoot, domain: "workspace", transactionId: "hash" })).toThrow("RECEIPT_CHAIN_TAMPERED");

    const linkRoot = root();
    appendReceiptEvent({ root: linkRoot, domain: "workspace", transactionId: "link", snapshot: { status: "one" } });
    appendReceiptEvent({ root: linkRoot, domain: "workspace", transactionId: "link", snapshot: { status: "two" } });
    const linked = readJson<ReceiptEvent>(eventPath(linkRoot, "link", 2));
    linked.previousEventHash = digest("e");
    linked.eventHash = hashObject(withoutEventHash(linked));
    atomicWrite(eventPath(linkRoot, "link", 2), prettyJson(linked));
    expect(() => readReceiptChain({ root: linkRoot, domain: "workspace", transactionId: "link" })).toThrow("RECEIPT_CHAIN_TAMPERED");

    const symlinkRoot = root();
    const outside = root();
    mkdirSync(join(symlinkRoot, "harness", "receipts", "workspace"), { recursive: true });
    symlinkSync(outside, join(symlinkRoot, "harness", "receipts", "workspace", "linked"));
    expect(() => readReceiptChain({ root: symlinkRoot, domain: "workspace", transactionId: "linked" })).toThrow("SYMLINK_TARGET_REJECTED");
    expect(() => readReceiptChain({ root: symlinkRoot, domain: "workspace", transactionId: "../escape" })).toThrow("RECEIPT_TRANSACTION_ID_INVALID");
  });
});

describe("last-known-good records", () => {
  it("binds real receipt events in an idempotent domain chain", () => {
    const base = root();
    const firstEvent = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "change-1", snapshot: { status: "applied" } });
    const firstArgs = {
      root: base, domain: "workspace", transactionId: "change-1",
      appliedReceiptEventHash: firstEvent.eventHash, planHash: digest("a"), observedHash: digest("b"),
    };
    const first = appendLkgRecord(firstArgs);
    expect(appendLkgRecord(firstArgs)).toEqual(first);

    const secondEvent = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "change-2", snapshot: { status: "applied" } });
    const second = appendLkgRecord({
      root: base, domain: "workspace", transactionId: "change-2",
      appliedReceiptEventHash: secondEvent.eventHash, planHash: digest("c"), observedHash: digest("d"),
    });
    expect(second.sequence).toBe(2);
    expect(second.previousRecordHash).toBe(first.recordHash);
    expect(readLatestLkgRecord({ root: base, domain: "workspace" })?.recordHash).toBe(second.recordHash);
    expect(readLkgChain({ root: base, domain: "workspace" })).toHaveLength(2);

    expect(() => appendLkgRecord({ ...firstArgs, planHash: digest("e") })).toThrow("LKG_BINDING_CONFLICT");
    expect(() => appendLkgRecord({ ...firstArgs, transactionId: "missing" })).toThrow("LKG_RECEIPT_EVENT_NOT_FOUND");
  });

  it("rejects a tampered LKG record", () => {
    const base = root();
    const event = appendReceiptEvent({ root: base, domain: "workspace", transactionId: "change", snapshot: { status: "applied" } });
    appendLkgRecord({
      root: base, domain: "workspace", transactionId: "change",
      appliedReceiptEventHash: event.eventHash, planHash: digest("a"), observedHash: digest("b"),
    });
    const path = join(base, "harness", "lkg", "workspace", "records", "000000000001.json");
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    value.observedHash = digest("c");
    atomicWrite(path, prettyJson(value));
    expect(() => readLkgChain({ root: base, domain: "workspace" })).toThrow("LKG_CHAIN_TAMPERED");
  });
});

describe("durable write-once", () => {
  it("never overwrites an existing target", () => {
    const path = join(root(), "receipts", "one.json");
    durableWriteOnce(path, "first");
    expect(() => durableWriteOnce(path, "second")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("first");
    expect(existsSync(path)).toBe(true);
  });

  it("rejects a symbolic-link receipt directory", () => {
    if (process.platform === "win32") return;
    const base = root();
    const external = root();
    const link = join(base, "receipts");
    symlinkSync(external, link);
    expect(() => durableWriteOnce(join(link, "one.json"), "first"))
      .toThrow("DURABLE_DIRECTORY_INVALID");
    expect(existsSync(join(external, "one.json"))).toBe(false);
  });
});

afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
