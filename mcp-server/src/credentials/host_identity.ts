import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { durableWriteOnce, prettyJson, sha256 } from "../v2/fs.js";

const identitySchema = z.object({
  schemaVersion: z.literal("host-identity/1.0"), hostId: z.string().uuid(),
  createdByPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const hostIdentityPlanSchema = z.object({
  path: z.string().min(1), beforeHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), hostId: z.string().uuid(),
}).strict();
export type HostIdentityPlan = z.infer<typeof hostIdentityPlanSchema>;

/** A fixed native location, never a project setting or a production CLI/env override. */
function identityPath(): string {
  let path = realpathSync(homedir());
  const home = lstatSync(path);
  if (!home.isDirectory() || (process.getuid && home.uid !== process.getuid())) throw new Error("HOST_IDENTITY_OWNER_INVALID");
  for (const part of [".harness-automation", "host", "identity.json"]) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || (part === "identity.json" ? !stat.isFile() : !stat.isDirectory()) ||
        (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) throw new Error("HOST_IDENTITY_STATE_UNSAFE");
    if (stat && part === "identity.json" && stat.size > 1024) throw new Error("HOST_IDENTITY_INVALID");
  }
  return path;
}

function observeIdentity() {
  const path = identityPath();
  if (!lstatSync(path, { throwIfNoEntry: false })) return { path, hash: null, identity: null };
  const content = readFileSync(path, "utf8");
  const parsed = identitySchema.safeParse(JSON.parse(content));
  if (!parsed.success) throw new Error("HOST_IDENTITY_INVALID");
  return { path, hash: sha256(content), identity: parsed.data };
}

export function requireHostIdentity(): string {
  const identity = observeIdentity().identity;
  if (!identity) throw new Error("HOST_IDENTITY_UNREGISTERED");
  return identity.hostId;
}

export function proposeHostIdentity(): HostIdentityPlan {
  const observed = observeIdentity();
  return { path: observed.path, beforeHash: observed.hash, hostId: observed.identity?.hostId ?? randomUUID() };
}

/** Called only after the enclosing exact registration approval and repository CAS checks. */
export function applyHostIdentity(input: HostIdentityPlan, planHash: string): void {
  const plan = hostIdentityPlanSchema.parse(input);
  const observed = observeIdentity();
  if (!/^[a-f0-9]{64}$/u.test(planHash) || plan.path !== observed.path) throw new Error("HOST_IDENTITY_PLAN_STALE");
  if (observed.identity) {
    if (observed.identity.hostId !== plan.hostId ||
        (observed.hash !== plan.beforeHash && !(plan.beforeHash === null && observed.identity.createdByPlanHash === planHash))) throw new Error("HOST_IDENTITY_PLAN_STALE");
    return;
  }
  if (plan.beforeHash !== null) throw new Error("HOST_IDENTITY_PLAN_STALE");
  for (const directory of [dirname(dirname(plan.path)), dirname(plan.path)]) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      const parent = openSync(dirname(directory), "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    identityPath();
  }
  const content = prettyJson({ schemaVersion: "host-identity/1.0", hostId: plan.hostId, createdByPlanHash: planHash });
  try { durableWriteOnce(plan.path, content, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(identityPath(), "utf8") !== content) throw new Error("HOST_IDENTITY_CREATE_FAILED", { cause: error });
  }
  if (requireHostIdentity() !== plan.hostId) throw new Error("HOST_IDENTITY_PLAN_STALE");
}
