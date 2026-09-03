import { existsSync, readdirSync } from "node:fs";
import { atomicWrite, canonicalJson, durableWriteOnce, hashObject, prettyJson, readJson, safePath } from "../v2/fs.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEQUENCE_FILE = /^\d{12}\.json$/u;

export interface ReceiptEvent<T = unknown> {
  schemaVersion: "receipt-event/1.0";
  domain: string;
  transactionId: string;
  sequence: number;
  previousEventHash: string | null;
  snapshotHash: string;
  snapshot: T;
  eventHash: string;
}

export interface LkgRecord {
  schemaVersion: "lkg-record/1.0";
  domain: string;
  transactionId: string;
  sequence: number;
  previousRecordHash: string | null;
  receiptEventHash: string;
  planHash: string;
  observedHash: string;
  recordHash: string;
}

export interface ReceiptKey {
  root: string;
  domain: string;
  transactionId: string;
}

export interface ReceiptProjection {
  root: string;
  path: string;
}

const receiptKeys = [
  "schemaVersion", "domain", "transactionId", "sequence", "previousEventHash",
  "snapshotHash", "snapshot", "eventHash",
].sort();
const lkgKeys = [
  "schemaVersion", "domain", "transactionId", "sequence", "previousRecordHash",
  "receiptEventHash", "planHash", "observedHash", "recordHash",
].sort();

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) fail(`${label}_INVALID`);
}

function normalizeSnapshot<T>(snapshot: T): T {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(snapshot);
  } catch {
    fail("RECEIPT_SNAPSHOT_INVALID");
  }
  if (encoded === undefined) fail("RECEIPT_SNAPSHOT_INVALID");
  const normalized = JSON.parse(encoded) as T;
  if (canonicalJson(snapshot) !== canonicalJson(normalized)) fail("RECEIPT_SNAPSHOT_INVALID");
  return normalized;
}

function sequenceName(sequence: number): string {
  return `${String(sequence).padStart(12, "0")}.json`;
}

function receiptDirectory(key: ReceiptKey): string {
  assertIdentifier(key.domain, "RECEIPT_DOMAIN");
  assertIdentifier(key.transactionId, "RECEIPT_TRANSACTION_ID");
  return safePath(key.root, `harness/receipts/${key.domain}/${key.transactionId}/events`);
}

function lkgDirectory(root: string, domain: string): string {
  assertIdentifier(domain, "RECEIPT_DOMAIN");
  return safePath(root, `harness/lkg/${domain}/records`);
}

function readSequence<T>(directory: string, code: string, parse: (value: unknown, sequence: number) => T): T[] {
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory).sort();
  if (names.some((name) => !SEQUENCE_FILE.test(name))) fail(code);
  return names.map((name, index) => {
    const sequence = index + 1;
    if (name !== sequenceName(sequence)) fail(code);
    try {
      return parse(readJson<unknown>(safePath(directory, name)), sequence);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SYMLINK_TARGET_REJECTED")) throw error;
      fail(code);
    }
  });
}

function receiptWithoutHash<T>(event: ReceiptEvent<T>): Omit<ReceiptEvent<T>, "eventHash"> {
  const copy: Partial<ReceiptEvent<T>> = { ...event };
  delete copy.eventHash;
  return copy as Omit<ReceiptEvent<T>, "eventHash">;
}

function parseReceiptEvent<T>(value: unknown, key: ReceiptKey, sequence: number): ReceiptEvent<T> {
  if (!record(value) || !exactKeys(value, receiptKeys)) fail("RECEIPT_CHAIN_TAMPERED");
  const event = value as unknown as ReceiptEvent<T>;
  if (event.schemaVersion !== "receipt-event/1.0" || event.domain !== key.domain ||
      event.transactionId !== key.transactionId || event.sequence !== sequence ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      (sequence === 1 ? event.previousEventHash !== null : !DIGEST.test(event.previousEventHash ?? "")) ||
      !DIGEST.test(event.snapshotHash) || !DIGEST.test(event.eventHash) ||
      !Object.prototype.hasOwnProperty.call(event, "snapshot") ||
      event.snapshotHash !== hashObject(event.snapshot) ||
      event.eventHash !== hashObject(receiptWithoutHash(event))) fail("RECEIPT_CHAIN_TAMPERED");
  return event;
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function readReceiptChain<T = unknown>(args: ReceiptKey & { compatibilitySnapshot?: unknown }): ReceiptEvent<T>[] {
  const chain = readSequence(receiptDirectory(args), "RECEIPT_CHAIN_TAMPERED", (value, sequence) =>
    parseReceiptEvent<T>(value, args, sequence));
  for (let index = 1; index < chain.length; index += 1) {
    if (chain[index].previousEventHash !== chain[index - 1].eventHash) fail("RECEIPT_CHAIN_TAMPERED");
  }
  if (Object.prototype.hasOwnProperty.call(args, "compatibilitySnapshot")) {
    const snapshot = normalizeSnapshot(args.compatibilitySnapshot);
    if (chain.length === 0 || !chain.some((event) => sameSnapshot(event.snapshot, snapshot))) {
      fail("RECEIPT_PROJECTION_DIVERGED");
    }
  }
  return chain;
}

export function readLatestReceiptEvent<T = unknown>(args: ReceiptKey & { compatibilitySnapshot?: unknown }): ReceiptEvent<T> | null {
  return readReceiptChain<T>(args).at(-1) ?? null;
}

function createReceiptEvent<T>(key: ReceiptKey, chain: ReceiptEvent<T>[], snapshot: T): ReceiptEvent<T> {
  const previous = chain.at(-1);
  const event: ReceiptEvent<T> = {
    schemaVersion: "receipt-event/1.0",
    domain: key.domain,
    transactionId: key.transactionId,
    sequence: chain.length + 1,
    previousEventHash: previous?.eventHash ?? null,
    snapshotHash: hashObject(snapshot),
    snapshot,
    eventHash: "",
  };
  event.eventHash = hashObject(receiptWithoutHash(event));
  return event;
}

function appendSnapshot<T>(key: ReceiptKey, chain: ReceiptEvent<T>[], snapshot: T): ReceiptEvent<T>[] {
  if (chain.some((event) => sameSnapshot(event.snapshot, snapshot))) return chain;
  const event = createReceiptEvent(key, chain, snapshot);
  try {
    durableWriteOnce(safePath(receiptDirectory(key), sequenceName(event.sequence)), prettyJson(event));
    return [...chain, event];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const refreshed = readReceiptChain<T>(key);
    if (refreshed.some((candidate) => sameSnapshot(candidate.snapshot, snapshot))) return refreshed;
    fail("RECEIPT_CHAIN_CONFLICT");
  }
}

function readProjection(projection: ReceiptProjection): { path: string; snapshot?: unknown } {
  const path = safePath(projection.root, projection.path);
  if (!existsSync(path)) return { path };
  try {
    return { path, snapshot: normalizeSnapshot(readJson<unknown>(path)) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SYMLINK_TARGET_REJECTED")) throw error;
    fail("RECEIPT_PROJECTION_DIVERGED");
  }
}

/** Persist the immutable event before updating its mutable compatibility projection. */
export function appendReceiptEvent<T>(args: ReceiptKey & {
  snapshot: T;
  projection?: ReceiptProjection;
}): ReceiptEvent<T> {
  let chain = readReceiptChain<T>(args);
  const projection = args.projection ? readProjection(args.projection) : undefined;
  if (projection?.snapshot !== undefined) {
    if (chain.length === 0) {
      chain = appendSnapshot(args, chain, normalizeSnapshot(projection.snapshot) as T);
    } else if (!chain.some((event) => sameSnapshot(event.snapshot, projection.snapshot))) {
      fail("RECEIPT_PROJECTION_DIVERGED");
    }
  }
  chain = appendSnapshot(args, chain, normalizeSnapshot(args.snapshot));
  const latest = chain.at(-1);
  if (!latest) fail("RECEIPT_CHAIN_TAMPERED");
  if (args.projection && (projection?.snapshot === undefined || !sameSnapshot(projection.snapshot, latest.snapshot))) {
    const current = readProjection(args.projection);
    if (current.snapshot !== undefined && !chain.some((event) => sameSnapshot(event.snapshot, current.snapshot))) {
      fail("RECEIPT_PROJECTION_DIVERGED");
    }
    if (current.snapshot === undefined || !sameSnapshot(current.snapshot, latest.snapshot)) {
      atomicWrite(current.path, prettyJson(latest.snapshot));
    }
  }
  return latest;
}

function lkgWithoutHash(recordValue: LkgRecord): Omit<LkgRecord, "recordHash"> {
  const copy: Partial<LkgRecord> = { ...recordValue };
  delete copy.recordHash;
  return copy as Omit<LkgRecord, "recordHash">;
}

function parseLkgRecord(value: unknown, domain: string, sequence: number): LkgRecord {
  if (!record(value) || !exactKeys(value, lkgKeys)) fail("LKG_CHAIN_TAMPERED");
  const item = value as unknown as LkgRecord;
  if (item.schemaVersion !== "lkg-record/1.0" || item.domain !== domain ||
      !IDENTIFIER.test(item.transactionId) || item.sequence !== sequence ||
      !Number.isSafeInteger(item.sequence) || item.sequence < 1 ||
      (sequence === 1 ? item.previousRecordHash !== null : !DIGEST.test(item.previousRecordHash ?? "")) ||
      !DIGEST.test(item.receiptEventHash) || !DIGEST.test(item.planHash) || !DIGEST.test(item.observedHash) ||
      !DIGEST.test(item.recordHash) || item.recordHash !== hashObject(lkgWithoutHash(item))) fail("LKG_CHAIN_TAMPERED");
  return item;
}

export function readLkgChain(args: { root: string; domain: string }): LkgRecord[] {
  const chain = readSequence(lkgDirectory(args.root, args.domain), "LKG_CHAIN_TAMPERED", (value, sequence) =>
    parseLkgRecord(value, args.domain, sequence));
  for (let index = 1; index < chain.length; index += 1) {
    if (chain[index].previousRecordHash !== chain[index - 1].recordHash) fail("LKG_CHAIN_TAMPERED");
  }
  for (const item of chain) {
    if (!readReceiptChain({ root: args.root, domain: args.domain, transactionId: item.transactionId })
      .some((event) => event.eventHash === item.receiptEventHash)) fail("LKG_CHAIN_TAMPERED");
  }
  return chain;
}

export function readLatestLkgRecord(args: { root: string; domain: string }): LkgRecord | null {
  return readLkgChain(args).at(-1) ?? null;
}

/** Record only an explicit, already-persisted applied receipt event as last-known-good. */
export function appendLkgRecord(args: ReceiptKey & {
  appliedReceiptEventHash: string;
  planHash: string;
  observedHash: string;
}): LkgRecord {
  assertIdentifier(args.transactionId, "RECEIPT_TRANSACTION_ID");
  if (![args.appliedReceiptEventHash, args.planHash, args.observedHash].every((digest) => DIGEST.test(digest))) {
    fail("LKG_BINDING_INVALID");
  }
  if (!readReceiptChain(args).some((event) => event.eventHash === args.appliedReceiptEventHash)) {
    fail("LKG_RECEIPT_EVENT_NOT_FOUND");
  }
  const chain = readLkgChain(args);
  const existing = chain.find((item) => item.receiptEventHash === args.appliedReceiptEventHash);
  if (existing) {
    if (existing.transactionId !== args.transactionId || existing.planHash !== args.planHash ||
        existing.observedHash !== args.observedHash) fail("LKG_BINDING_CONFLICT");
    return existing;
  }
  const previous = chain.at(-1);
  const item: LkgRecord = {
    schemaVersion: "lkg-record/1.0",
    domain: args.domain,
    transactionId: args.transactionId,
    sequence: chain.length + 1,
    previousRecordHash: previous?.recordHash ?? null,
    receiptEventHash: args.appliedReceiptEventHash,
    planHash: args.planHash,
    observedHash: args.observedHash,
    recordHash: "",
  };
  item.recordHash = hashObject(lkgWithoutHash(item));
  try {
    durableWriteOnce(safePath(lkgDirectory(args.root, args.domain), sequenceName(item.sequence)), prettyJson(item));
    return item;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = readLkgChain(args).find((candidate) => candidate.receiptEventHash === args.appliedReceiptEventHash);
    if (concurrent && concurrent.transactionId === args.transactionId && concurrent.planHash === args.planHash &&
        concurrent.observedHash === args.observedHash) return concurrent;
    fail("LKG_CHAIN_CONFLICT");
  }
}
