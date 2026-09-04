import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { abandonClientProcess, readClientSettlement, runClientStep, settleClientProcess, startClientProcess, type ClientProcess } from "./client_process.js";

// Replace only the fixed worker peer; real Node IPC, child handles, process groups and OS observations remain exercised.
const spawned = vi.hoisted(() => ({ groups: [] as number[] }));
vi.mock("node:child_process", async (original) => {
  const native = await original<typeof import("node:child_process")>();
  return { ...native, spawn: ((command, args, options) => {
    const child = native.spawn(command, args!.map((arg) => arg.endsWith("/client_worker.ts")
      ? fileURLToPath(new URL("./__fixtures__/client-process.mjs", import.meta.url)) : arg), options!);
    if (child.pid) spawned.groups.push(child.pid); return child;
  }) as typeof native.spawn };
});
const roots: string[] = []; const handles: ClientProcess[] = []; const digest = "a".repeat(64);
async function launch(mode = "normal") {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "supervised-client-"))); roots.push(container);
  const root = join(container, mode); mkdirSync(root);
  const handle = await startClientProcess({ projectRoot: root, approvalRef: digest, manifestHash: digest, clientId: "local", bindingHash: digest });
  handles.push(handle); return { root, handle };
}
afterEach(async () => {
  handles.splice(0).forEach(abandonClientProcess);
  // Test-created descendants have an explicit release file and an independent bounded self-exit; no numeric PID kill.
  for (const root of roots) for (const mode of ["normal", "descendant", "orphan", "residual", "wrong-nonce"]) {
    if (existsSync(join(root, mode))) writeFileSync(join(root, mode, "release"), "stop");
  }
  const deadline = performance.now() + 10_000;
  while (true) {
    const groups = execFileSync("ps", ["-axo", "pgid="], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/u).map(Number);
    if (spawned.groups.every((group) => !groups.includes(group))) break;
    if (performance.now() > deadline) throw new Error("FIXTURE_PROCESS_GROUP_REMAINED");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  spawned.groups.length = 0;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}, 15_000);

it("requires an actual owned child and observed group drain before issuing settlement", async () => {
  const { handle } = await launch(); expect(() => readClientSettlement(handle)).toThrow("QUALIFICATION_PROCESS_DRAIN_UNPROVEN");
  expect(await runClientStep(handle, "one")).toBe(digest); await settleClientProcess(handle);
  expect(readClientSettlement(handle)).toMatchObject({ leader: { parent: process.pid }, finalMembers: [] });
  expect(() => readClientSettlement({ ...handle })).toThrow("QUALIFICATION_PROCESS_ORIGIN_UNPROVEN");
  await expect(runClientStep(handle, "one")).rejects.toThrow("QUALIFICATION_PROCESS_NOT_READY");
});

it("does not confuse completed synchronous work or quiescent IPC with descendant exit", async () => {
  const { root, handle } = await launch("descendant"); await runClientStep(handle, "one");
  const settled = settleClientProcess(handle);
  expect(await Promise.race([settled.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 150))])).toBe("waiting");
  writeFileSync(join(root, "release"), "stop"); await settled;
  expect(readClientSettlement(handle).finalMembers).toEqual([]);
});

it.each(["complete", "abort"] as const)("retains unresolved descendants and never upgrades an abandoned run to settled (%s)", async (mode) => {
  const { handle } = await launch("residual"); await runClientStep(handle, "one");
  await expect(settleClientProcess(handle, mode)).rejects.toThrow("QUALIFICATION_PROCESS_DESCENDANTS_UNSETTLED");
  abandonClientProcess(handle); expect(() => readClientSettlement(handle)).toThrow("QUALIFICATION_PROCESS_DRAIN_UNPROVEN");
}, 15_000);

it.each(["complete", "abort"] as const)("refuses wrong IPC identity and abnormal leader exit even if a result was already received (%s)", async (mode) => {
  await expect(launch("wrong-nonce")).rejects.toThrow("QUALIFICATION_PROCESS_PROTOCOL_INVALID");
  const { handle } = await launch("orphan");
  try { await runClientStep(handle, "one"); } catch { /* Exit may race the last IPC result, but can never attest drain. */ }
  await expect(settleClientProcess(handle, mode)).rejects.toThrow();
  expect(() => readClientSettlement(handle)).toThrow("QUALIFICATION_PROCESS_DRAIN_UNPROVEN");
});

it("preserves a required host-capability gate reported by its actual child", async () => {
  await expect(launch("environment-blocked")).rejects.toThrow("ENVIRONMENT_BLOCKED: PROCESS_GROUP_INSPECTION_UNAVAILABLE");
});

it.each(["operation-failed", "unfinished"])("settles a cooperative abort without erasing execution failure or requiring every step (%s)", async (mode) => {
  const { handle } = await launch(mode);
  if (mode === "operation-failed") await expect(runClientStep(handle, "one")).rejects.toThrow("FIXTURE_OPERATION_FAILED");
  if (mode === "operation-failed") await expect(settleClientProcess(handle)).rejects.toThrow("QUALIFICATION_PROCESS_NOT_READY");
  await settleClientProcess(handle, "abort");
  expect(readClientSettlement(handle)).toMatchObject({ executionStatus: "aborted", finalMembers: [],
    operationError: mode === "operation-failed" ? "FIXTURE_OPERATION_FAILED" : null });
  const proof = readClientSettlement(handle); await settleClientProcess(handle, "abort"); expect(readClientSettlement(handle)).toEqual(proof);
  await expect(runClientStep(handle, "one")).rejects.toThrow("QUALIFICATION_PROCESS_NOT_READY");
});
