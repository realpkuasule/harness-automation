import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { Buffer } from "node:buffer";

export const CREDENTIAL_PURPOSES = ["git-transport", "github-api", "github-admin", "reviewer"] as const;
export type CredentialPurpose = typeof CREDENTIAL_PURPOSES[number];

export interface CredentialRef {
  id: string;
  purpose: CredentialPurpose;
  hostId: string;
  repository: string;
  identity: string;
  scopes: string[];
  expiresAt: string;
  envVar: string;
}

interface ResolvedCredential { secret: string; ref: CredentialRef; }
export interface CredentialResolver { resolve(ref: CredentialRef): ResolvedCredential; }
interface CredentialEvidence { identity: string; repository: string; repositoryId?: string; capabilities: string[]; status: number; }

/** Explicit test seam; production always uses the fixed GitHub probe below. */
export interface CredentialTestAdapter { probe(ref: CredentialRef, env: NodeJS.ProcessEnv): CredentialEvidence; }

const ENVIRONMENT_VARIABLE: Record<CredentialPurpose, string> = {
  "git-transport": "HARNESS_GIT_TOKEN", "github-api": "GH_TOKEN", "github-admin": "GH_TOKEN", reviewer: "HARNESS_REVIEWER_TOKEN",
};

export function scrubSensitive(value: string, secrets: string[] = []): string {
  let scrubbed = value;
  for (const secret of secrets.filter(Boolean)) scrubbed = scrubbed.split(secret).join("[REDACTED]");
  return scrubbed
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:GH_TOKEN|GITHUB_TOKEN|HARNESS_REVIEWER_TOKEN)\s*[=:]\s*[^\s,;]+/giu, (match) => `${match.split(/[=:]/u)[0]}=[REDACTED]`)
    .replace(/\bAuthorization\s*:\s*[^\r\n]+/giu, "Authorization: [REDACTED]")
    .replace(/(["'](?:access_?token|refresh_?token|token|secret|password)["']\s*:\s*["'])[^"']+(["'])/giu, "$1[REDACTED]$2");
}

function sameRef(left: CredentialRef, right: CredentialRef): boolean {
  return left.id === right.id && left.purpose === right.purpose && left.hostId === right.hostId && left.repository === right.repository &&
    left.identity === right.identity && left.expiresAt === right.expiresAt && left.envVar === right.envVar &&
    left.scopes.length === right.scopes.length && left.scopes.every((scope, index) => scope === right.scopes[index]);
}

function credentialEnv(ref: CredentialRef, secret: string): NodeJS.ProcessEnv {
  const gitTransport = ref.purpose === "git-transport"
    ? {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${secret}`, "utf8").toString("base64")}`,
      }
    : {};
  return {
    PATH: process.env.PATH,
    CI: "1",
    ...gitTransport,
    [ref.envVar]: secret,
  };
}

function statusFromOutput(output: string): number {
  const match = output.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/mu);
  return match ? Number(match[1]) : 200;
}

function fixedProbe(ref: CredentialRef, env: NodeJS.ProcessEnv, requiredCapability: string): CredentialEvidence {
  if (ref.purpose === "reviewer") throw new Error("DG02_REVIEWER_CONFIGURATION_REQUIRED");
  // Git and API retain distinct refs, but share one fixed, explicitly authenticated probe.
  const probeEnv = { PATH: env.PATH, CI: "1", GH_TOKEN: env[ref.envVar] };
  const request = (endpoint: string): unknown => {
    const result = spawnSync("gh", ["api", "-i", "--method", "GET", endpoint], { env: probeEnv, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("ENVIRONMENT_BLOCKED: CREDENTIAL_PROBE_UNAVAILABLE");
    const status = statusFromOutput(result.stdout ?? "");
    if (status === 401 || status === 403) throw new Error("CREDENTIAL_ACCESS_DENIED");
    if (result.error || result.status !== 0 || status < 200 || status >= 300) throw new Error("CREDENTIAL_CAPABILITY_DENIED");
    const offset = result.stdout.search(/\r?\n\r?\n/u);
    try { return JSON.parse(offset < 0 ? result.stdout : result.stdout.slice(offset)); }
    catch { throw new Error("CREDENTIAL_PROBE_RESPONSE_INVALID"); }
  };
  const identity = request("user") as { login?: string };
  const repo = request(`repos/${ref.repository}`) as { full_name?: string; id?: number | string };
  if (!identity || !repo || typeof identity.login !== "string" || typeof repo.full_name !== "string") throw new Error("CREDENTIAL_PROBE_RESPONSE_INVALID");
  const capabilities = ["metadata:read"];
  if (requiredCapability === "contents:read") {
    if (!Array.isArray(request(`repos/${ref.repository}/git/matching-refs/heads`))) throw new Error("CREDENTIAL_PROBE_RESPONSE_INVALID");
    capabilities.push("contents:read");
  }
  // A read probe never manufactures write permission from scopes or repo.permissions.
  return { identity: identity.login, repository: repo.full_name, repositoryId: repo.id === undefined ? undefined : String(repo.id), capabilities, status: 200 };
}

function validateRef(ref: CredentialRef, expectedPurpose: CredentialPurpose, now: Date): void {
  if (!CREDENTIAL_PURPOSES.includes(ref.purpose) || !ref.id || !ref.hostId || !ref.repository || !ref.identity || ref.purpose !== expectedPurpose ||
      ref.envVar !== ENVIRONMENT_VARIABLE[ref.purpose] || !Number.isFinite(Date.parse(ref.expiresAt)) || Date.parse(ref.expiresAt) <= now.getTime()) throw new Error("CREDENTIAL_INVALID");
}

function validateCredential(ref: CredentialRef, expectedPurpose: CredentialPurpose, evidence: CredentialEvidence, requiredCapability: string, now: Date): void {
  validateRef(ref, expectedPurpose, now);
  if (evidence.status === 401 || evidence.status === 403) throw new Error("CREDENTIAL_ACCESS_DENIED");
  if (evidence.status < 200 || evidence.status >= 300 || evidence.identity !== ref.identity || evidence.repository !== ref.repository ||
      !evidence.capabilities.includes(requiredCapability)) throw new Error("CREDENTIAL_CAPABILITY_DENIED");
}

export function runWithCredential(args: {
  ref: CredentialRef;
  purpose: CredentialPurpose;
  resolver: CredentialResolver;
  command: string;
  argv: string[];
  requiredCapability: string;
  repositoryId?: string;
  runner?: (command: string, argv: string[], env: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
  testAdapter?: CredentialTestAdapter;
  now?: Date;
}): { status: number | null; stdout: string; stderr: string; credentialRef: string; identity: string; expiresAt: string } {
  // DG-02 is checked before any test or production probe can resolve or expose a reviewer secret.
  if (args.purpose === "reviewer" || args.ref.purpose === "reviewer") {
    throw new Error("DG02_REVIEWER_CONFIGURATION_REQUIRED");
  }
  validateRef(args.ref, args.purpose, args.now ?? new Date());
  let resolved: ResolvedCredential;
  try {
    resolved = args.resolver.resolve(args.ref);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "ENVIRONMENT_BLOCKED: SECURITY_TOOL_UNAVAILABLE") throw new Error(message);
    // A failing resolver has not supplied the secret to scrub; never echo its arbitrary error.
    if (["CREDENTIAL_OS_ADAPTER_UNAVAILABLE", "CREDENTIAL_KEYCHAIN_ACCESS_DENIED", "CREDENTIAL_BINDING_STALE", "CREDENTIAL_REF_UNREGISTERED"].includes(message)) throw new Error(message);
    throw new Error("CREDENTIAL_RESOLUTION_FAILED");
  }
  if (!sameRef(resolved.ref, args.ref) || !resolved.secret) throw new Error("CREDENTIAL_RESOLUTION_FAILED");
  const derivedSecrets = args.purpose === "git-transport"
    ? [resolved.secret, Buffer.from(`x-access-token:${resolved.secret}`, "utf8").toString("base64")]
    : [resolved.secret];
  if ([args.command, ...args.argv].some((value) => derivedSecrets.some((secret) => value.includes(secret)))) throw new Error("CREDENTIAL_SECRET_IN_ARGUMENTS");
  try {
    const env = credentialEnv(args.ref, resolved.secret);
    const evidence = args.testAdapter ? args.testAdapter.probe(args.ref, env) : fixedProbe(args.ref, env, args.requiredCapability);
    validateCredential(args.ref, args.purpose, evidence, args.requiredCapability, args.now ?? new Date());
    if (args.repositoryId !== undefined && evidence.repositoryId !== args.repositoryId) throw new Error("CREDENTIAL_REPOSITORY_ID_MISMATCH");
    const result = (args.runner ?? ((command, argv, childEnv) => spawnSync(command, argv, { env: childEnv, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 })))(args.command, args.argv, env);
    if (result.error || result.status !== 0) throw new Error(`CREDENTIAL_COMMAND_FAILED: ${result.stderr || result.stdout || result.error || "unknown error"}`);
    return { status: result.status, stdout: scrubSensitive(result.stdout ?? "", derivedSecrets), stderr: scrubSensitive(result.stderr ?? "", derivedSecrets), credentialRef: args.ref.id, identity: args.ref.identity, expiresAt: args.ref.expiresAt };
  } catch (error) {
    throw new Error(scrubSensitive(error instanceof Error ? error.message : String(error), derivedSecrets));
  }
}
