import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ParsedArguments } from "../cli.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { githubEndpointRepository, remotePushEndpoint } from "../repository/remote.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { durableWriteOnce, hashObject, prettyJson, safePath } from "../v2/fs.js";
import { applyCredentialHostBinding, loadCredentialHostBinding, planCredentialHostBinding, type CredentialBindingInput, type CredentialBindingPlan, type CredentialHostBinding } from "./host_binding.js";

/** Registration binds metadata only: it never reads a token or implies verified capabilities. */
export function runCredentialCommand(projectRoot: string, args: ParsedArguments): unknown {
  const allowed = new Set(["project", "remote", "input", "plan", "approve"]);
  if (args.flags.size || args.positionals.length !== 1 || [...args.values].some(([key, values]) => !allowed.has(key) || values.length !== 1)) throw new Error("CREDENTIAL_ARGUMENTS_INVALID");
  const required = (name: string) => {
    const value = args.values.get(name)?.[0]; if (!value) throw new Error(`ARGUMENT_REQUIRED: --${name}`); return value;
  };
  const read = (name: string): unknown => {
    try { return JSON.parse(readFileSync(resolve(projectRoot, required(name)), "utf8")); }
    catch { throw new Error(`CREDENTIAL_INPUT_INVALID: --${name}`); }
  };
  const { commonDir, projectDir } = resolveRepositoryContext(projectRoot);
  const remote = args.values.get("remote")?.[0] ?? "origin";
  const endpoint = remotePushEndpoint(projectDir, remote);
  const repository = githubEndpointRepository(endpoint.value, remote);
  const requireEndpoint = (binding: CredentialHostBinding | CredentialBindingInput) => {
    if (!binding || binding.repository !== repository || binding.endpointHash !== endpoint.hash) throw new Error("CREDENTIAL_REPOSITORY_BINDING_MISMATCH");
  };
  if (args.positionals[0] === "plan") {
    const input = read("input") as CredentialBindingInput;
    requireEndpoint(input);
    const plan = planCredentialHostBinding(commonDir, input);
    const inputHash = hashObject(plan.binding);
    const approval = createSemanticApprovalPacket({
      planHash: plan.planHash, inputHash, producerIdentity: "credential-registration",
      binding: {
        planHash: plan.planHash, inputDigest: inputHash,
        contextDigest: hashObject({ commonDir, repository, endpointHash: endpoint.hash }),
        // Registration has a fixed explicit-human policy, independent of an unconfigured reviewer.
        policyDigest: hashObject({ contract: "credential-host-binding/1.0", approval: "explicit-human" }),
        observedHash: hashObject({ beforeHash: plan.beforeHash, beforeLkgHash: plan.beforeLkgHash, worktreeBindingHash: plan.worktreeBindingHash, hostIdentity: plan.hostIdentity }),
      },
      actions: [{ id: "credential-registration", kind: "permission-change", protected: true, reversible: true,
        summary: `Register ${input.credentials.length} credential reference(s) for ${repository}; ${plan.hostIdentity.beforeHash === null ? "create" : "reuse"} installation ID ${plan.binding.hostId} at ${plan.hostIdentity.path}; no secret is read.`,
        before: plan.beforeHash ?? "unregistered", after: plan.binding.bindingHash,
        recovery: "Reapply this exact plan to recover its projection; approve a new plan to replace the binding." }],
    });
    const planPath = safePath(commonDir, `harness/plans/credentials-${plan.planHash}.json`);
    mkdirSync(dirname(planPath), { recursive: true, mode: 0o700 });
    if (!existsSync(planPath)) durableWriteOnce(planPath, prettyJson(plan), 0o600);
    return { planPath, plan, approval, secretsRead: false, capabilitiesVerified: false };
  }
  if (args.positionals[0] === "apply") {
    const plan = read("plan") as CredentialBindingPlan;
    requireEndpoint(plan?.binding);
    applyCredentialHostBinding(commonDir, plan, required("approve"));
    const binding = loadCredentialHostBinding(commonDir, { repository, repositoryId: plan.binding.repositoryId, endpointHash: endpoint.hash });
    return { registered: true, binding, secretsRead: false, capabilitiesVerified: false };
  }
  throw new Error("CREDENTIAL_COMMAND_REQUIRED: choose plan or apply");
}
