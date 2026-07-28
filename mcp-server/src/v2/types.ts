export const HARNESS_VERSION = "2.0" as const;

export const STACK_ID_PATTERN_SOURCE = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
export const MAX_STACKS = 16;

export const SUPPORTED_STACKS = [
  "typescript",
  "python",
  "go",
  "postgresql",
  "grpc",
  "kubernetes",
] as const;

export type SupportedStack = typeof SUPPORTED_STACKS[number];
export type Stack = string;
export type StackAdapterSupport = "deterministic" | "procedural" | "guidance" | "none";

const STACK_ID_PATTERN = new RegExp(STACK_ID_PATTERN_SOURCE, "u");

export function hasBuiltInStackAdapter(stack: Stack): stack is SupportedStack {
  return (SUPPORTED_STACKS as readonly string[]).includes(stack);
}

export function stackAdapterSupport(stack: Stack): StackAdapterSupport {
  if (["typescript", "python", "go"].includes(stack)) return "deterministic";
  if (stack === "kubernetes") return "procedural";
  if (["postgresql", "grpc"].includes(stack)) return "guidance";
  return "none";
}

export function normalizeStackIds(values: readonly string[]): Stack[] {
  if (values.length > MAX_STACKS) {
    throw new Error(`TOO_MANY_STACKS: at most ${MAX_STACKS} stack identifiers are allowed`);
  }
  const stacks = [...new Set(values.map((value) => value.trim()))];
  const invalid = stacks.filter((stack) => stack.length > 64 || !STACK_ID_PATTERN.test(stack));
  if (invalid.length > 0) {
    throw new Error(
      `INVALID_STACK: ${invalid.join(", ")}; use lowercase kebab-case identifiers such as typescript, csharp, or godot`,
    );
  }
  return stacks;
}

export type StackProfile =
  | "full-typescript"
  | "python-data-ai"
  | "go-performance"
  | "custom";

export const DELIVERY_PROFILES = ["worktree-delivery"] as const;
export const DOMAIN_PROFILES = ["game-development"] as const;
export type DeliveryProfile = typeof DELIVERY_PROFILES[number];
export type DomainProfile = typeof DOMAIN_PROFILES[number];

export interface SourceSnapshot {
  id: string;
  kind: "prd" | "design" | "research" | "existing-policy";
  path: string;
  sha256: string;
  approved: boolean;
}
export interface Intake {
  schemaVersion: "2.0";
  owner: string;
  approvedAt: string;
  sources: SourceSnapshot[];
}

export interface Evidence {
  fact: string;
  paths: string[];
  confidence: number;
}

export interface AgentDiscovery {
  id: "portable" | "claude-code" | "codex" | "unknown";
  capabilities: Array<
    | "root-instructions"
    | "scoped-instructions"
    | "instruction-imports"
    | "session-hooks"
    | "mcp"
    | "structured-output"
  >;
  evidence: string[];
}

export interface Discovery {
  schemaVersion: "2.0";
  generatedAt: string;
  profile: StackProfile;
  stacks: Stack[];
  manifests: string[];
  lockfiles: string[];
  packages: string[];
  commands: Record<string, string[]>;
  boundaries: string[];
  agents: AgentDiscovery[];
  evidence: Evidence[];
  warnings: string[];
}

export type PolicyTargetKind =
  | "agent-instruction"
  | "formatter"
  | "linter"
  | "type-checker"
  | "schema-validator"
  | "contract-test"
  | "git-hook"
  | "ci"
  | "repository-setting"
  | "custom-command";

export interface PolicyRule {
  id: string;
  title: string;
  statement: string;
  rationale: string;
  owner: string;
  sourceRefs: string[];
  scope: {
    include: string[];
    exclude: string[];
    boundaries: Array<
      "code" | "api" | "rpc" | "database" | "queue" | "generated-code" | "deployment"
    >;
  };
  formalization: "deterministic" | "procedural" | "cognitive";
  severity: "info" | "warn" | "error";
  status: "proposed" | "active" | "disabled";
  targets: Array<{
    kind: PolicyTargetKind;
    adapter: string;
    configPath?: string;
    command?: string[];
  }>;
  verification: {
    commands: string[][];
    passCriteria: string;
    timeoutSeconds?: number;
  };
  examples?: { valid?: string[]; invalid?: string[] };
  changeControl: { approvalRequired: boolean; migrationRequired: boolean };
}

export interface PolicyDocument {
  schemaVersion: "2.0";
  project: {
    name: string;
    owner: string;
    phase: "design-approved" | "development" | "maintenance";
    stacks: Stack[];
    deliveryProfiles: DeliveryProfile[];
    domainProfiles: DomainProfile[];
  };
  sources: SourceSnapshot[];
  agents: {
    portableInstructionFile: "AGENTS.md";
    adapters: Array<{ id: string; capabilities: AgentDiscovery["capabilities"] }>;
  };
  policies: PolicyRule[];
}

export interface FileOperation {
  id: string;
  kind: "write";
  path: string;
  beforeHash: string | null;
  afterHash: string;
  content: string;
  managed: boolean;
}

export interface ChangePlan {
  schemaVersion: "2.0";
  id: string;
  createdAt: string;
  projectDir: string;
  intakeHash: string;
  discoveryHash: string;
  sourceHashes: Array<{ path: string; sha256: string }>;
  operations: FileOperation[];
  commands: string[][];
  warnings: string[];
  planHash: string;
}

export interface AppliedChange {
  schemaVersion: "2.0";
  id: string;
  planHash: string;
  appliedAt: string;
  operations: Array<{
    path: string;
    beforeHash: string | null;
    afterHash: string;
    backupPath: string | null;
  }>;
}

export interface EnforcementResult {
  id: string;
  configured: boolean;
  loaded: boolean;
  enforced: boolean;
  passing: boolean;
  status: "verified" | "failing" | "blocked" | "guidance";
  detail: string;
}

export interface StackAdapterResult {
  stack: Stack;
  support: StackAdapterSupport;
  available: boolean;
  status: "available" | "blocked";
  detail: string;
}
