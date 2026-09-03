import { spawnSync, type SpawnSyncReturns } from "node:child_process";

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
interface CredentialEvidence { identity: string; repository: string; capabilities: string[]; status: number; }

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
  return {
    PATH: process.env.PATH,
    CI: "1",
    ...(ref.purpose === "git-transport" ? { GIT_TERMINAL_PROMPT: "0" } : {}),
    [ref.envVar]: secret,
  };
}

function statusFromOutput(output: string): number {
  const match = output.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/mu);
  return match ? Number(match[1]) : 200;
}

function fixedProbe(ref: CredentialRef, env: NodeJS.ProcessEnv): CredentialEvidence {
  if (ref.purpose === "reviewer") {
    throw new Error("DG02_REVIEWER_CONFIGURATION_REQUIRED");
  }
  if (ref.purpose === "git-transport") throw new Error("CREDENTIAL_TRANSPORT_HELPER_REQUIRED");
  const request = (argv: string[]) => spawnSync("gh", argv, { env, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const user = request(["api", "-i", "user"]);
  if (user.error) throw new Error("ENVIRONMENT_BLOCKED: CREDENTIAL_PROBE_UNAVAILABLE");
  const status = statusFromOutput(user.stdout ?? user.stderr ?? "");
  if (status === 401 || status === 403) return { identity: "", repository: "", capabilities: [], status };
  if (user.status !== 0) throw new Error("CREDENTIAL_CAPABILITY_DENIED");
  const userText = user.stdout ?? "";
  const headerEnd = userText.search(/\r?\n\r?\n/u);
  const identity = JSON.parse(headerEnd < 0 ? userText : userText.slice(headerEnd)) as { login?: string };
  const repository = request(["api", `repos/${ref.repository}`]);
  const repositoryStatus = statusFromOutput(repository.stdout ?? repository.stderr ?? "");
  if (repositoryStatus === 401 || repositoryStatus === 403) return { identity: "", repository: "", capabilities: [], status: repositoryStatus };
  if (repository.error) throw new Error("ENVIRONMENT_BLOCKED: CREDENTIAL_PROBE_UNAVAILABLE");
  if (repository.status !== 0) throw new Error("CREDENTIAL_CAPABILITY_DENIED");
  const repo = JSON.parse(repository.stdout ?? "{}") as { full_name?: string };
  const scopeHeader = userText.match(/^x-oauth-scopes:\s*(.*)$/imu)?.[1] ?? "";
  return { identity: identity.login ?? "", repository: repo.full_name ?? "", capabilities: scopeHeader.split(",").map((scope) => scope.trim()).filter(Boolean), status };
}

function validateCredential(ref: CredentialRef, expectedPurpose: CredentialPurpose, evidence: CredentialEvidence, requiredCapability: string, now: Date): void {
  if (!CREDENTIAL_PURPOSES.includes(ref.purpose) || !ref.id || !ref.hostId || !ref.repository || !ref.identity || ref.purpose !== expectedPurpose ||
      ref.envVar !== ENVIRONMENT_VARIABLE[ref.purpose] || !Number.isFinite(Date.parse(ref.expiresAt)) || Date.parse(ref.expiresAt) <= now.getTime()) throw new Error("CREDENTIAL_INVALID");
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
  runner?: (command: string, argv: string[], env: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
  testAdapter?: CredentialTestAdapter;
  now?: Date;
}): { status: number | null; stdout: string; stderr: string; credentialRef: string; identity: string; expiresAt: string } {
  let resolved: ResolvedCredential;
  try {
    resolved = args.resolver.resolve(args.ref);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/keychain|credential.*store|unavailable/iu.test(message)) throw new Error("ENVIRONMENT_BLOCKED: CREDENTIAL_STORE_UNAVAILABLE");
    throw new Error(`CREDENTIAL_RESOLUTION_FAILED: ${scrubSensitive(message)}`);
  }
  if (!sameRef(resolved.ref, args.ref) || !resolved.secret) throw new Error("CREDENTIAL_RESOLUTION_FAILED");
  if ([args.command, ...args.argv].some((value) => value.includes(resolved.secret))) throw new Error("CREDENTIAL_SECRET_IN_ARGUMENTS");
  const env = credentialEnv(args.ref, resolved.secret);
  const evidence = args.testAdapter ? args.testAdapter.probe(args.ref, env) : fixedProbe(args.ref, env);
  validateCredential(args.ref, args.purpose, evidence, args.requiredCapability, args.now ?? new Date());
  const result = (args.runner ?? ((command, argv, childEnv) => spawnSync(command, argv, { env: childEnv, encoding: "utf8", maxBuffer: 1024 * 1024 })))(args.command, args.argv, env);
  if (result.error || result.status !== 0) throw new Error(`CREDENTIAL_COMMAND_FAILED: ${scrubSensitive(`${result.stderr ?? result.stdout ?? result.error ?? ""}`, [resolved.secret])}`);
  return { status: result.status, stdout: scrubSensitive(result.stdout ?? "", [resolved.secret]), stderr: scrubSensitive(result.stderr ?? "", [resolved.secret]), credentialRef: args.ref.id, identity: args.ref.identity, expiresAt: args.ref.expiresAt };
}
