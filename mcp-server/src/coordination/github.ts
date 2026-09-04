import { z } from "zod";
import { resolveRepositoryContext } from "../repository/git.js";
import { githubEndpointRepository, remotePushEndpoint } from "../repository/remote.js";
import { loadCredentialHostBinding, macOSKeychainResolver, type CredentialHostBinding } from "../credentials/host_binding.js";
import { runWithCredential } from "../credentials/service.js";
import { hashObject } from "../v2/fs.js";
import { CoordinationClock } from "./clock.js";
import type { CoordinationRecord, MergeEvidence } from "./types.js";

const id = z.union([z.string().regex(/^[1-9][0-9]*$/u), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).transform(String);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const pullRequest = z.object({
  id, number: z.number().int().positive(), state: z.literal("closed"), merged: z.literal(true),
  merged_at: z.string().datetime(), merge_commit_sha: sha,
  head: z.object({ sha, ref: z.string(), repo: z.object({ id }) }),
  base: z.object({ ref: z.string(), repo: z.object({ id, full_name: z.string() }) }),
});

/** Production read adapter: approved native binding -> Keychain -> the existing Broker -> fixed GitHub GET. */
export class GitHubCoordinationReader {
  private readonly binding: CredentialHostBinding;
  private readonly projectDir: string;
  private readonly endpointHash: string;
  constructor(projectRoot: string, private readonly remote: string, repositoryId: string, private readonly credentialId: string) {
    const context = resolveRepositoryContext(projectRoot); this.projectDir = context.projectDir;
    const endpoint = remotePushEndpoint(this.projectDir, remote); this.endpointHash = endpoint.hash;
    this.binding = loadCredentialHostBinding(context.commonDir, { repository: githubEndpointRepository(endpoint.value, remote), repositoryId, endpointHash: endpoint.hash });
    if (!this.binding.credentials.some((ref) => ref.id === credentialId && ref.purpose === "github-api")) throw new Error("CREDENTIAL_REF_UNREGISTERED");
  }
  private read(endpoint: string) {
    if (remotePushEndpoint(this.projectDir, this.remote).hash !== this.endpointHash) throw new Error("CREDENTIAL_REPOSITORY_BINDING_MISMATCH");
    const ref = this.binding.credentials.find((item) => item.id === this.credentialId)!;
    const clock = new CoordinationClock(); const started = clock.start();
    const result = runWithCredential({ ref, purpose: "github-api", resolver: macOSKeychainResolver(this.binding),
      command: "gh", argv: ["api", "--hostname", "github.com", "-i", "--method", "GET", endpoint],
      requiredCapability: "metadata:read", repositoryId: this.binding.repositoryId });
    const parts = result.stdout.split(/\r?\n\r?\n/u);
    const headers = parts.shift() ?? "";
    if (!/^HTTP\/\d(?:\.\d)? 200(?:\s|$)/u.test(headers)) throw new Error("COORDINATION_PROVIDER_RESPONSE_INVALID");
    const dates = headers.split(/\r?\n/u).filter((line) => /^date:/iu.test(line));
    if (dates.length !== 1) throw new Error("COORDINATION_PROVIDER_DATE_INVALID");
    const serverDate = dates[0].slice(5).trim(); clock.observe(serverDate, started);
    let body: unknown;
    try { body = JSON.parse(parts.join("\n\n")); } catch { throw new Error("COORDINATION_PROVIDER_RESPONSE_INVALID"); }
    return { body, clock, serverDate, ref };
  }
  serverClock(): CoordinationClock {
    const observed = this.read(`repos/${this.binding.repository}`);
    const repo = z.object({ id, full_name: z.literal(this.binding.repository) }).safeParse(observed.body);
    if (!repo.success || repo.data.id !== this.binding.repositoryId) throw new Error("CREDENTIAL_REPOSITORY_ID_MISMATCH");
    return observed.clock;
  }
  observeMerge(record: CoordinationRecord, number: number, baseRef: string): MergeEvidence {
    if (!Number.isSafeInteger(number) || number < 1 || !baseRef || record.repository !== this.binding.repository ||
        record.repositoryId !== this.binding.repositoryId || record.machine !== this.binding.hostId) throw new Error("COORDINATION_MERGE_BINDING_INVALID");
    const observed = this.read(`repos/${this.binding.repository}/pulls/${number}`);
    if (observed.ref.identity !== record.owner) throw new Error("COORDINATION_MERGE_BINDING_INVALID");
    const parsed = pullRequest.safeParse(observed.body);
    if (!parsed.success) throw new Error("COORDINATION_MERGE_UNPROVEN");
    const pr = parsed.data;
    if (pr.number !== number || pr.head.sha !== record.lastObservedHead || pr.head.ref !== record.branch ||
        pr.head.repo.id !== record.sourceRepositoryId || pr.base.repo.id !== record.repositoryId ||
        pr.base.repo.full_name !== record.repository || pr.base.ref !== baseRef ||
        Date.parse(pr.merged_at) > observed.clock.bounds().upperMs) throw new Error("COORDINATION_MERGE_BINDING_INVALID");
    const evidence: MergeEvidence = { pullRequestNumber: number, pullRequestId: pr.id, integratedSourceHead: pr.head.sha,
      integratedCommit: pr.merge_commit_sha, headRef: pr.head.ref, headRepositoryId: pr.head.repo.id, baseRef,
      baseRepositoryId: pr.base.repo.id, mergedAt: pr.merged_at, observedAt: observed.serverDate,
      observer: observed.ref.identity, hostId: this.binding.hostId, credentialBindingHash: this.binding.bindingHash, evidenceHash: "" };
    evidence.evidenceHash = hashObject({ ...evidence, evidenceHash: undefined }); return evidence;
  }
}
