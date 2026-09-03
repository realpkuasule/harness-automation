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

interface ResolvedCredential {
  secret: string;
  ref: CredentialRef;
}

export interface CredentialResolver {
  resolve(ref: CredentialRef): ResolvedCredential;
}

export interface CredentialCanary {
  identity: string;
  repository: string;
  capabilities: string[];
  status: number;
}

export interface CredentialProbe {
  probe(ref: CredentialRef, env: NodeJS.ProcessEnv): CredentialCanary;
}

const ENVIRONMENT_VARIABLE: Record<CredentialPurpose, string> = {
  "git-transport": "GIT_ASKPASS",
  "github-api": "GH_TOKEN",
  "github-admin": "GH_TOKEN",
  reviewer: "HARNESS_REVIEWER_TOKEN",
};

export function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

export function validateCredential(ref: CredentialRef, expectedPurpose: CredentialPurpose, canary: CredentialCanary, requiredCapability: string, now = new Date()): void {
  if (!CREDENTIAL_PURPOSES.includes(ref.purpose) || !ref.id || !ref.hostId || !ref.repository || !ref.identity ||
      ref.purpose !== expectedPurpose || ref.envVar !== ENVIRONMENT_VARIABLE[ref.purpose] || Date.parse(ref.expiresAt) <= now.getTime()) throw new Error("CREDENTIAL_INVALID");
  if (canary.status === 401 || canary.status === 403) throw new Error("CREDENTIAL_ACCESS_DENIED");
  if (canary.status < 200 || canary.status >= 300 || canary.identity !== ref.identity ||
      canary.repository !== ref.repository || !canary.capabilities.includes(requiredCapability)) {
    throw new Error("CREDENTIAL_CAPABILITY_DENIED");
  }
}

export function runWithCredential(args: {
  ref: CredentialRef;
  purpose: CredentialPurpose;
  resolver: CredentialResolver;
  command: string;
  argv: string[];
  requiredCapability: string;
  probe: CredentialProbe;
  runner?: (command: string, argv: string[], env: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
  now?: Date;
}): { status: number | null; stdout: string; stderr: string; credentialRef: string } {
  const resolved = args.resolver.resolve(args.ref);
  if (resolved.ref.id !== args.ref.id || !resolved.secret) throw new Error("CREDENTIAL_RESOLUTION_FAILED");
  if ([args.command, ...args.argv].some((value) => value.includes(resolved.secret))) {
    throw new Error("CREDENTIAL_SECRET_IN_ARGUMENTS");
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: "1",
    [args.ref.envVar]: resolved.secret,
  };
  validateCredential(args.ref, args.purpose, args.probe.probe(args.ref, env), args.requiredCapability, args.now);
  const result = (args.runner ?? ((command, argv, childEnv) => spawnSync(command, argv, {
    env: childEnv, encoding: "utf8", maxBuffer: 1024 * 1024,
  })))(args.command, args.argv, env);
  if (result.error || result.status !== 0) {
    throw new Error(`CREDENTIAL_COMMAND_FAILED: ${redactSecret(`${result.stderr ?? result.stdout ?? ""}`, resolved.secret)}`);
  }
  return {
    status: result.status,
    stdout: redactSecret(result.stdout ?? "", resolved.secret),
    stderr: redactSecret(result.stderr ?? "", resolved.secret),
    credentialRef: args.ref.id,
  };
}
