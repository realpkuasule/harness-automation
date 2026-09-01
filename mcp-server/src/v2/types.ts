export const HARNESS_VERSION = "2.0" as const;
export const TYPESCRIPT_NAMING_RULE_ID = "typescript-naming" as const;

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
export const QUALITY_PROFILES = ["eval-driven-development"] as const;
export type DeliveryProfile = typeof DELIVERY_PROFILES[number];
export type DomainProfile = typeof DOMAIN_PROFILES[number];
export type QualityProfile = typeof QUALITY_PROFILES[number];

export interface CompilerIdentity {
  package: "@realpkuasule/harness-automation";
  version: string;
}

export type CompilerVersionStatus = "current" | "stale" | "legacy-version-unknown" | "unconfigured";

export interface SourceSnapshot {
  id: string;
  kind: "prd" | "design" | "research" | "eval" | "existing-policy";
  path: string;
  sha256: string;
  approved: boolean;
}
export interface Intake {
  schemaVersion: "2.0";
  owner: string;
  approvedAt: string;
  sources: SourceSnapshot[];
  typescriptNamingAdoption?: {
    ruleId: typeof TYPESCRIPT_NAMING_RULE_ID;
    fingerprints: string[];
  };
  policyWeakeningApproval?: {
    digest: string;
    ruleIds: string[];
  };
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
  evaluations?: EvaluationDiscovery;
}

export interface EvalGrader {
  id: string;
  kind: "code" | "model" | "human";
  role: "gate" | "guidance";
  calibrationEvidence?: string;
}

export type EvalBaselineOrigin = "pre-implementation" | "adoption" | "legacy-unknown";

export interface EvalTraceability {
  requirementId: string;
  ruleIds: string[];
}

export interface EvalNegativeControl {
  command: string[];
  fixture: string;
  expectedExitCode: number;
}

export interface EvalSuite {
  id: string;
  kind: "capability" | "regression";
  owner: string;
  description: string;
  command: string[];
  tasks: string[];
  baseline: { origin: EvalBaselineOrigin; score: number; trials: number; evidence: string };
  target: {
    metric: "pass-rate" | "pass-at-1" | "pass-all-trials";
    threshold: number;
    trials: number;
  };
  graders: EvalGrader[];
  /** Repository-relative runner and manifest inputs whose approved contents make an eval reproducible. */
  runnerSources?: string[];
  traceability?: EvalTraceability[];
  negativeControl?: EvalNegativeControl;
}

export interface EvalContract {
  $schema?: string;
  schemaVersion: "1.0" | "1.1";
  suites: EvalSuite[];
}

export interface EvaluationDiscovery {
  configured: boolean;
  valid: boolean;
  contractPath: string | null;
  schemaVersion: EvalContract["schemaVersion"] | null;
  suites: Array<Pick<EvalSuite, "id" | "kind" | "command" | "tasks" | "baseline" | "target" | "graders" | "runnerSources" | "traceability" | "negativeControl">>;
  errors: string[];
  unmanagedCandidates: string[];
}

export interface PolicyEvaluationSnapshot {
  schemaVersion: EvalContract["schemaVersion"];
  suites: EvaluationDiscovery["suites"];
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
  | "custom-command"
  | "evaluation";

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
      "code" | "api" | "rpc" | "database" | "queue" | "generated-code" | "deployment" | "evaluation"
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

export interface TypeScriptNamingBaseline {
  ruleId: typeof TYPESCRIPT_NAMING_RULE_ID;
  approvedIntakeHash: string;
  fingerprints: string[];
}

export interface PolicyDocument {
  schemaVersion: "2.0";
  /** Optional while reading legacy policies; every newly compiled policy records it. */
  compiler?: CompilerIdentity;
  /** Rule-bound TypeScript naming debt explicitly adopted through intake and an immutable plan. */
  typescriptNamingBaseline?: TypeScriptNamingBaseline;
  /** Canonical EDD semantics used to detect policy weakening across compiler updates. */
  evaluations?: PolicyEvaluationSnapshot;
  project: {
    name: string;
    owner: string;
    phase: "design-approved" | "development" | "maintenance";
    /** Optional while reading legacy policies; every newly compiled policy records it. */
    profile?: StackProfile;
    stacks: Stack[];
    deliveryProfiles: DeliveryProfile[];
    domainProfiles: DomainProfile[];
    qualityProfiles?: QualityProfile[];
  };
  sources: SourceSnapshot[];
  agents: {
    portableInstructionFile: "AGENTS.md";
    adapters: Array<{ id: string; capabilities: AgentDiscovery["capabilities"] }>;
  };
  policies: PolicyRule[];
}

export interface SemanticFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface WorktreeUpdateStatus {
  status: "not-configured" | "compatible" | "configuration-plan-required" | "migration-required";
  configurationPlanPath: string | null;
  configurationPlanHash: string | null;
  migrationCommand: string[] | null;
  error: string | null;
}

export interface PolicyUpdateMetadata {
  from: {
    compiler: CompilerIdentity | null;
    policyCompiler: CompilerIdentity | null;
    manifestCompiler: CompilerIdentity | null;
    compilerStatus: "exact" | "stale" | "legacy-version-unknown";
    schemaVersion: string | null;
    policyDigest: string | null;
  };
  to: { compiler: CompilerIdentity; schemaVersion: "2.0"; policyDigest: string };
  inherited: {
    owner: string;
    profile: StackProfile;
    stacks: Stack[];
    deliveryProfiles: DeliveryProfile[];
    domainProfiles: DomainProfile[];
    qualityProfiles: QualityProfile[];
    phase: PolicyDocument["project"]["phase"];
  };
  drift: {
    intake: { expected: string; actual: string; clean: boolean };
    discovery: { expected: string; actual: string; clean: boolean };
    sources: Array<{ path: string; expected: string; actual: string | null; clean: boolean }>;
  };
  rules: {
    added: string[];
    removed: string[];
    changed: Array<{ ruleId: string; fields: SemanticFieldChange[] }>;
  };
  evaluations: {
    added: string[];
    removed: string[];
    changed: Array<{ suiteId: string; fields: SemanticFieldChange[] }>;
  };
  adapterCoverage: {
    before: string[];
    after: string[];
    added: string[];
    removed: string[];
  };
  baseline: {
    before: string[];
    after: string[];
    added: string[];
    removed: string[];
  } | null;
  targets: Array<{ path: string; beforeHash: string | null; afterHash: string }>;
  weakening: {
    detected: boolean;
    ruleIds: string[];
    reasons: string[];
    digest: string;
    approved: boolean;
  };
  worktree: WorktreeUpdateStatus;
  migrationRequired: boolean;
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
  update?: PolicyUpdateMetadata;
  /** Read-only compatibility for plans created by the 2.8.1 preview. New plans never write this field. */
  upgrade?: PolicyUpdateMetadata;
  planHash: string;
}

/** @deprecated Use PolicyUpdateMetadata. */
export type PolicyUpgradeMetadata = PolicyUpdateMetadata;
/** @deprecated Use WorktreeUpdateStatus. */
export type WorktreeUpgradeStatus = WorktreeUpdateStatus;

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
