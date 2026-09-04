import { assertMutationLock, withMutationLock, type MutationLock } from "../recovery/service.js";
import { resolveRepositoryContext, type RepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import type { HumanScopeBinding } from "../approval/human.js";
import type { CoordinationClock } from "./clock.js";
import { assertCoordinationIdentity, assertCoordinationWorkspace } from "./authority.js";
import { requireWriteLease } from "./leases.js";
import { assertExpected } from "./record.js";
import type { GitCoordinationStore } from "./store.js";
import type { CoordinationExpected, CoordinationRecord } from "./types.js";

export type ManagedWriteContext = {
  context: RepositoryContext; store: GitCoordinationStore;
  observeAuthority: (record: CoordinationRecord) => HumanScopeBinding; refreshClock: () => CoordinationClock;
};

/** Existing lock owners call this at their actual write boundary, never a cached session admission. */
export function assertManagedWriteAllowedLocked(ctx: ManagedWriteContext, held: MutationLock,
  workItem: string, expectedControlSha: string, expected: CoordinationExpected) {
  assertMutationLock(ctx.context, held);
  if (hashObject(resolveRepositoryContext(ctx.context.projectDir)) !== hashObject(ctx.context)) throw new Error("COORDINATION_WORKSPACE_BINDING_MISMATCH");
  const current = ctx.store.read(workItem);
  if (current.controlSha !== expectedControlSha) throw new Error("COORDINATION_CAS_CONFLICT");
  if (!current.record) throw new Error("COORDINATION_RECORD_ABSENT");
  const binding = ctx.observeAuthority(current.record);
  if (binding.commonDir !== ctx.context.commonDir) throw new Error("COORDINATION_WORKSPACE_BINDING_MISMATCH");
  assertExpected(current.record, expected); assertCoordinationIdentity(current.record, binding);
  assertCoordinationWorkspace(ctx.context.projectDir, current.record);
  requireWriteLease(current.record, expected, ctx.refreshClock()); assertMutationLock(ctx.context, held);
  return current.record;
}

/** Bounded workspace edits only; commit/rebind owners use the Locked API and validate their new exact tuple. */
export async function runManagedWrite<T>(ctx: ManagedWriteContext, workItem: string, expectedControlSha: string,
  expected: CoordinationExpected, operation: (held: MutationLock) => T | Promise<T>): Promise<T> {
  return withMutationLock(ctx.context, async (held) => {
    assertManagedWriteAllowedLocked(ctx, held, workItem, expectedControlSha, expected);
    const result = await operation(held); // Callers must await all child writes; fire-and-forget is not covered.
    assertManagedWriteAllowedLocked(ctx, held, workItem, expectedControlSha, expected);
    return result;
  });
}
