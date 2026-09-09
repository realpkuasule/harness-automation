import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hashObject } from "../v2/fs.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["step", "prepare", "dispatch", "recover-rejected"]), nonce: z.string().uuid(), stepId: id }).strict(),
  z.object({ type: z.literal("stop"), nonce: z.string().uuid() }).strict(),
  z.object({ type: z.literal("abort-stop"), nonce: z.string().uuid() }).strict(),
  z.object({ type: z.literal("exit"), nonce: z.string().uuid() }).strict(),
]);
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), nonce: z.string().uuid(), pid: z.number().int().positive(), bindingHash: digest }).strict(),
  z.object({ type: z.literal("result"), nonce: z.string().uuid(), stepId: id, resultHash: digest }).strict(),
  z.object({ type: z.literal("quiescent"), nonce: z.string().uuid() }).strict(),
  z.object({ type: z.literal("failure"), nonce: z.string().uuid(), code: z.string().regex(/^(?:ENVIRONMENT_BLOCKED: )?[A-Z][A-Z0-9_]{0,127}$/u), recoverable: z.literal(true).optional() }).strict(),
]);
type Message = z.infer<typeof messageSchema>;
type Member = { pid: number; parent: number; group: number; started: string };
type Pending = { accept: (message: Message) => boolean; resolve: (message: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type ClientProcess = Readonly<{ kind: "native-qualification-client" }>;
export type ClientLaunch = { projectRoot: string; approvalRef: string; manifestHash: string; clientId: string; bindingHash: string;
  role?: "writer" | "rejected-recovery"; attemptId?: string };
type State = { child: ChildProcess; launch: ClientLaunch; nonce: string; pid: number; identity?: Member; pending?: Pending; failure?: Error; operationFailure?: Error;
  phase: "starting" | "ready" | "running" | "operation-failed" | "stopping" | "quiescent" | "exiting" | "settled" | "failed"; outputBytes: number;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  settlement?: { leader: Member; finalMembers: Member[]; executionStatus: "completed" | "aborted"; operationError: string | null } };
const clients = new WeakMap<ClientProcess, State>();
function stateOf(handle: ClientProcess): State {
  const state = clients.get(handle); if (!state) throw new Error("QUALIFICATION_PROCESS_ORIGIN_UNPROVEN"); return state;
}

/** Fixed OS metadata only, never command lines. Missing inspection is not proof that a group is empty. */
function groupMembers(group: number): Member[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, LC_ALL: "C" } });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("ENVIRONMENT_BLOCKED: PROCESS_GROUP_INSPECTION_UNAVAILABLE");
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("QUALIFICATION_PROCESS_OBSERVATION_FAILED");
  return result.stdout.trimEnd().split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) throw new Error("QUALIFICATION_PROCESS_OBSERVATION_FAILED");
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4] };
  }).filter((member) => member.group === group);
}
function fail(state: State, code: string): void {
  state.failure ??= new Error(code); state.phase = "failed";
  if (state.pending) { clearTimeout(state.pending.timer); state.pending.reject(state.failure); state.pending = undefined; }
}
function waiting(state: State, accept: Pending["accept"], timeoutMs: number): Promise<Message> {
  if (state.failure) return Promise.reject(state.failure);
  if (state.pending) return Promise.reject(new Error("QUALIFICATION_PROCESS_BUSY"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(state, "QUALIFICATION_PROCESS_TIMEOUT"), timeoutMs);
    state.pending = { accept, resolve, reject, timer };
  });
}
function send(state: State, command: z.infer<typeof clientCommandSchema>): void {
  if (state.failure) return;
  if (!state.child.connected) { fail(state, "QUALIFICATION_PROCESS_DISCONNECTED"); return; }
  try { state.child.send(command, (error) => { if (error) fail(state, "QUALIFICATION_PROCESS_DISCONNECTED"); }); }
  catch { fail(state, "QUALIFICATION_PROCESS_DISCONNECTED"); }
}
function liveIdentity(state: State, members: Member[]): Member {
  const leader = members.find((member) => member.pid === state.pid);
  if (state.failure || state.child.exitCode !== null || state.child.signalCode !== null || !state.child.connected ||
      !leader || leader.group !== state.pid || leader.parent !== process.pid || state.identity && hashObject(leader) !== hashObject(state.identity)) throw new Error("QUALIFICATION_PROCESS_IDENTITY_UNPROVEN");
  return leader;
}

/** No executable/argv/Provider seam: only this package's fixed worker can be launched by the native runner. */
export async function startClientProcess(launch: ClientLaunch): Promise<ClientProcess> {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("ENVIRONMENT_BLOCKED: PROCESS_GROUP_INSPECTION_UNAVAILABLE");
  digest.parse(launch.approvalRef); digest.parse(launch.manifestHash); digest.parse(launch.bindingHash); id.parse(launch.clientId);
  const role = z.enum(["writer", "rejected-recovery"]).parse(launch.role ?? "writer");
  if (role === "rejected-recovery") z.string().uuid().parse(launch.attemptId);
  else if (launch.attemptId !== undefined) throw new Error("QUALIFICATION_PROCESS_ROLE_INVALID");
  const source = import.meta.url.endsWith(".ts"); const entry = fileURLToPath(new URL(source ? "./client_worker.ts" : "./client_worker.js", import.meta.url));
  const loader = source ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [];
  const nonce = randomUUID();
  const child = spawn(process.execPath, [...loader, entry, launch.projectRoot, launch.approvalRef, launch.manifestHash, launch.clientId, nonce, role, ...(launch.attemptId ? [launch.attemptId] : [])], {
    cwd: launch.projectRoot, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: "1" },
  });
  const handle: ClientProcess = Object.freeze({ kind: "native-qualification-client" });
  let closed!: (value: Awaited<State["closed"]>) => void;
  const state: State = { child, launch: structuredClone(launch), nonce, pid: child.pid ?? 0, phase: "starting", outputBytes: 0,
    closed: new Promise((resolve) => { closed = resolve; }) };
  clients.set(handle, state);
  child.on("error", () => fail(state, "QUALIFICATION_PROCESS_START_FAILED"));
  child.on("close", (code, signal) => { closed({ code, signal }); if (state.phase !== "exiting" || code !== 0 || signal !== null) fail(state, "QUALIFICATION_PROCESS_EXIT_UNEXPECTED"); });
  for (const stream of [child.stdout, child.stderr]) stream!.on("data", (data: Buffer) => {
    state.outputBytes += data.length; if (state.outputBytes > 64 * 1024) fail(state, "QUALIFICATION_PROCESS_OUTPUT_LIMIT");
  });
  child.on("message", (input: unknown) => {
    const parsed = messageSchema.safeParse(input);
    if (!parsed.success || parsed.data.nonce !== nonce) { fail(state, "QUALIFICATION_PROCESS_PROTOCOL_INVALID"); return; }
    const message = parsed.data;
    if (message.type === "failure") {
      if (!message.recoverable) { fail(state, message.code); return; }
      if (state.phase !== "running" || !state.pending || state.failure) { fail(state, "QUALIFICATION_PROCESS_PROTOCOL_INVALID"); return; }
      // An operation failure may stop cooperatively, but can never resume work or become a successful execution.
      state.operationFailure = new Error(message.code); state.phase = "operation-failed";
      const pending = state.pending; state.pending = undefined; clearTimeout(pending.timer); pending.reject(state.operationFailure); return;
    }
    if (!state.pending || !state.pending.accept(message)) { fail(state, "QUALIFICATION_PROCESS_PROTOCOL_INVALID"); return; }
    const pending = state.pending; state.pending = undefined; clearTimeout(pending.timer); pending.resolve(message);
  });
  try {
    await waiting(state, (message) => message.type === "ready" && message.pid === state.pid && message.bindingHash === launch.bindingHash, 30_000);
    state.identity = liveIdentity(state, groupMembers(state.pid)); state.phase = "ready"; return handle;
  } catch (error) { abandonClientProcess(handle); throw error; }
}

export async function runClientStep(handle: ClientProcess, stepId: string, action: "step" | "prepare" | "dispatch" | "recover-rejected" = "step"): Promise<string> {
  const state = stateOf(handle); id.parse(stepId);
  if (state.phase !== "ready") throw new Error("QUALIFICATION_PROCESS_NOT_READY");
  liveIdentity(state, groupMembers(state.pid)); state.phase = "running";
  const result = waiting(state, (message) => message.type === "result" && message.stepId === stepId, 180_000);
  send(state, { type: action, nonce: state.nonce, stepId });
  const message = await result; if (state.failure) throw state.failure;
  state.phase = "ready"; return (message as Extract<Message, { type: "result" }>).resultHash;
}

export async function settleClientProcess(handle: ClientProcess, mode: "complete" | "abort" = "complete"): Promise<void> {
  const state = stateOf(handle);
  if (mode === "abort" && state.phase === "settled") { readClientSettlement(handle); return; }
  if (state.failure || state.phase !== "ready" && !(mode === "abort" && state.phase === "operation-failed")) throw new Error("QUALIFICATION_PROCESS_NOT_READY");
  state.phase = "stopping";
  const quiescent = waiting(state, (message) => message.type === "quiescent", 10_000); send(state, { type: mode === "abort" ? "abort-stop" : "stop", nonce: state.nonce });
  await quiescent; state.phase = "quiescent";
  const started = performance.now(); let members: Member[];
  while (true) {
    members = groupMembers(state.pid); liveIdentity(state, members);
    if (members.length === 1) break;
    if (performance.now() - started >= 5000) throw new Error("QUALIFICATION_PROCESS_DESCENDANTS_UNSETTLED", { cause: { members } });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  state.phase = "exiting"; send(state, { type: "exit", nonce: state.nonce });
  let timer!: NodeJS.Timeout;
  try {
    const result = await Promise.race([state.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("QUALIFICATION_PROCESS_EXIT_TIMEOUT")), 10_000); })]);
    if (state.failure || result.code !== 0 || result.signal !== null) throw new Error("QUALIFICATION_PROCESS_EXIT_UNEXPECTED");
    const finalMembers = groupMembers(state.pid); if (finalMembers.length) throw new Error("QUALIFICATION_PROCESS_DESCENDANTS_UNSETTLED");
    state.settlement = { leader: state.identity!, finalMembers, executionStatus: mode === "abort" ? "aborted" : "completed", operationError: state.operationFailure?.message ?? null }; state.phase = "settled";
  } finally { clearTimeout(timer); }
}

export function readClientSettlement(handle: ClientProcess) {
  const state = stateOf(handle);
  if (state.phase !== "settled" || !state.settlement || state.failure) throw new Error("QUALIFICATION_PROCESS_DRAIN_UNPROVEN");
  return structuredClone({ launch: state.launch, nonce: state.nonce, ...state.settlement });
}

/** Cooperative disconnect only. Unknown/reused numeric PID/PGID is never a target, and abandonment never attests drain. */
export function abandonClientProcess(handle: ClientProcess): void {
  const state = stateOf(handle); if (state.phase === "settled") return;
  fail(state, "QUALIFICATION_PROCESS_ABANDONED");
  if (state.child.connected) state.child.disconnect();
  state.child.stdout?.destroy(); state.child.stderr?.destroy(); state.child.unref();
}
