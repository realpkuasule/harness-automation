import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentialHostBinding, macOSKeychainResolver, type CredentialHostBinding } from "../credentials/host_binding.js";
import { runWithCredential } from "../credentials/service.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { githubEndpointRepository, remotePushEndpoint } from "../repository/remote.js";
import type { CoordinationTransport } from "./store.js";

export interface CoordinationWriteIntent {
  repository: string; repositoryId: string; endpointHash: string; credentialBindingHash: string;
  credentialRef: string; actor: string; hostId: string; ref: string; head: string; expected: string | null;
}
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const localEnv = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
function requireRef(ref: string): void {
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(ref) || ref.includes("..") ||
      ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) throw new Error("COORDINATION_CONTROL_REF_INVALID");
}

/** The object directory is a private, config-free bare store, never a delivery checkout. */
function requireObjectDirectory(directory: string): void {
  if (directory !== realpathSync(directory)) throw new Error("COORDINATION_OBJECT_DIRECTORY_INVALID");
  for (const part of ["", "config", "objects", "objects/info", "info"]) {
    const stat = lstatSync(join(directory, part), { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))) throw new Error("COORDINATION_OBJECT_DIRECTORY_INVALID");
  }
  for (const part of ["objects/info/alternates", "objects/info/http-alternates", "info/grafts", "commondir", "shallow"]) {
    if (lstatSync(join(directory, part), { throwIfNoEntry: false })) throw new Error("COORDINATION_OBJECT_DIRECTORY_INVALID");
  }
  const result = spawnSync("git", ["config", "--file", join(directory, "config"), "--no-includes", "--null", "--list"], { env: localEnv(), encoding: "utf8", timeout: 10_000, maxBuffer: 8192 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("ENVIRONMENT_BLOCKED: GIT_UNAVAILABLE");
  const rows = result.stdout?.split("\0").filter(Boolean) ?? [];
  if (result.error || result.status !== 0 || !rows.includes("core.bare\ntrue") || rows.some((row) => !/^(?:core\.(?:repositoryformatversion\n[01]|filemode\n(?:true|false)|bare\ntrue|ignorecase\n(?:true|false)|precomposeunicode\n(?:true|false))|extensions\.objectformat\nsha256)$/u.test(row))) throw new Error("COORDINATION_OBJECT_DIRECTORY_INVALID");
}

/** Narrow production adapter; scopes and metadata never manufacture write authorization. */
export class GitHubCoordinationTransport implements CoordinationTransport {
  readonly repository: string;
  readonly repositoryId: string;
  private readonly binding: CredentialHostBinding;
  private readonly projectDir: string;
  private readonly endpoint: { value: string; hash: string };
  constructor(projectRoot: string, private readonly remote: string, repositoryId: string, private readonly credentialId: string,
    // Supplied only by the real qualification/production authority composition, not a CLI boolean or JSON proof.
    private readonly authorizeWrite?: (intent: CoordinationWriteIntent) => void) {
    const context = resolveRepositoryContext(projectRoot); this.projectDir = context.projectDir;
    this.endpoint = remotePushEndpoint(this.projectDir, remote);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(this.endpoint.value)) throw new Error("CREDENTIAL_HTTPS_ENDPOINT_REQUIRED");
    this.repository = githubEndpointRepository(this.endpoint.value, remote); this.repositoryId = repositoryId;
    this.binding = loadCredentialHostBinding(context.commonDir, { repository: this.repository, repositoryId, endpointHash: this.endpoint.hash });
    if (!this.binding.credentials.some((ref) => ref.id === credentialId && ref.purpose === "git-transport")) throw new Error("CREDENTIAL_REF_UNREGISTERED");
  }
  private execute(directory: string, argv: string[], beforeDispatch?: () => void) {
    requireObjectDirectory(directory);
    if (remotePushEndpoint(this.projectDir, this.remote).hash !== this.endpoint.hash) throw new Error("CREDENTIAL_REPOSITORY_BINDING_MISMATCH");
    const ref = this.binding.credentials.find((item) => item.id === this.credentialId)!;
    return runWithCredential({ ref, purpose: "git-transport", resolver: macOSKeychainResolver(this.binding),
      command: "git", cwd: directory, argv: ["--no-replace-objects", `--git-dir=${directory}`, ...argv],
      requiredCapability: "metadata:read", repositoryId: this.repositoryId, preserveFailure: true, beforeDispatch });
  }
  readRef(ref: string): string | null {
    requireRef(ref);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-coordination-read-")));
    try {
      const initialized = spawnSync("git", ["init", "--bare", "--quiet", "--template=", directory], { env: localEnv(), encoding: "utf8", timeout: 10_000 });
      if ((initialized.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("ENVIRONMENT_BLOCKED: GIT_UNAVAILABLE");
      if (initialized.error || initialized.status !== 0) throw new Error("COORDINATION_OBJECT_DIRECTORY_INVALID");
      const result = this.execute(directory, ["ls-remote", "--heads", this.endpoint.value, ref]);
      if (result.error || result.status !== 0) throw new Error("COORDINATION_REMOTE_OBSERVATION_FAILED");
      const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
      if (lines.length === 0) return null;
      const [head, observedRef] = lines[0].split(/\s+/u);
      if (lines.length !== 1 || !SHA.test(head) || observedRef !== ref) throw new Error("COORDINATION_REMOTE_OBSERVATION_INVALID");
      return head;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  fetch(directory: string, sha: string): void {
    if (!SHA.test(sha)) throw new Error("COORDINATION_CONTROL_OBJECT_INVALID");
    const result = this.execute(directory, ["fetch", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", this.endpoint.value, sha]);
    if (result.error || result.status !== 0) throw new Error("COORDINATION_FETCH_FAILED");
  }
  push(directory: string, sha: string, ref: string, expected: string | null) {
    requireRef(ref);
    if (!SHA.test(sha) || (expected !== null && !SHA.test(expected))) throw new Error("COORDINATION_CONTROL_OBJECT_INVALID");
    if (!this.authorizeWrite) throw new Error("COORDINATION_WRITE_AUTHORIZATION_REQUIRED");
    const credential = this.binding.credentials.find((item) => item.id === this.credentialId)!;
    const intent = { repository: this.repository, repositoryId: this.repositoryId, endpointHash: this.endpoint.hash,
      credentialBindingHash: this.binding.bindingHash, credentialRef: credential.id, actor: credential.identity,
      hostId: this.binding.hostId, ref, head: sha, expected };
    // Identity probes can be slow: authority/time checks and reservation belong immediately before dispatch.
    return this.execute(directory, ["push", "--porcelain", "--no-verify", "--recurse-submodules=no", `--force-with-lease=${ref}:${expected ?? ""}`, this.endpoint.value, `${sha}:${ref}`], () => this.authorizeWrite!(intent));
  }
}
