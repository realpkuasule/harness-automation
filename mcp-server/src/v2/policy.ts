import { basename } from "node:path";
import type {
  Discovery,
  DeliveryProfile,
  DomainProfile,
  Intake,
  PolicyDocument,
  PolicyRule,
  QualityProfile,
  SourceSnapshot,
  Stack,
  StackProfile,
} from "./types.js";
import { normalizeStackIds, stackAdapterSupport } from "./types.js";
import { DELIVERY_PROFILES, DOMAIN_PROFILES, QUALITY_PROFILES } from "./types.js";

export const MANAGED_START = "<!-- harness-automation:v2:start -->";
export const MANAGED_END = "<!-- harness-automation:v2:end -->";

export function stacksForProfile(profile: StackProfile, observed: Stack[]): Stack[] {
  const mapped: Record<Exclude<StackProfile, "custom">, Stack[]> = {
    "full-typescript": ["typescript", "postgresql"],
    "python-data-ai": ["python", "typescript", "postgresql", "kubernetes"],
    "go-performance": ["go", "typescript", "postgresql", "grpc", "kubernetes"],
  };
  return profile === "custom" ? observed : mapped[profile];
}

function rule(
  base: Pick<PolicyRule, "id" | "title" | "statement" | "rationale" | "scope" | "formalization" | "severity" | "targets" | "verification" | "examples">,
  owner: string,
  sources: SourceSnapshot[],
): PolicyRule {
  return {
    ...base,
    owner,
    sourceRefs: sources.map((source) => source.id),
    status: "active",
    changeControl: { approvalRequired: true, migrationRequired: base.id.includes("naming") },
  };
}

function validateProfiles<T extends string>(
  values: readonly T[],
  supported: readonly T[],
  name: string,
): T[] {
  const selected = [...new Set(values)];
  const invalid = selected.filter((value) => !supported.includes(value));
  if (invalid.length > 0) throw new Error(`INVALID_${name}_PROFILE: ${invalid.join(", ")}`);
  return selected;
}

function commonRules(owner: string, sources: SourceSnapshot[]): PolicyRule[] {
  return [
    rule({
      id: "single-implementation-owner",
      title: "Single implementation owner",
      statement: "Before implementation, search for an existing implementation and record the owning module; do not create a parallel implementation of the same capability.",
      rationale: "Parallel AI sessions otherwise duplicate the same capability and split maintenance ownership.",
      scope: { include: ["**/*"], exclude: [".harness/**", "**/generated/**"], boundaries: ["code"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable", configPath: "AGENTS.md" }],
      verification: { commands: [["harness-automation", "context", "--project", "."]], passCriteria: "The session receipt records policy digest and implementation ownership review." },
    }, owner, sources),
    rule({
      id: "contract-first-change",
      title: "Contract-first interface changes",
      statement: "Change shared API, RPC, schema, database, or queue contracts before changing consumers; update compatibility tests in the same change.",
      rationale: "A stable source of truth prevents different sessions from implementing different interface assumptions.",
      scope: { include: ["**/*"], exclude: [".harness/**"], boundaries: ["api", "rpc", "database", "queue"] },
      formalization: "cognitive",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable", configPath: ".harness/generated/effective-policy.md" }],
      verification: { commands: [], passCriteria: "Review confirms that contract sources and consumers changed together." },
    }, owner, sources),
    rule({
      id: "generated-files-immutable",
      title: "Generated files are immutable",
      statement: "Never edit generated code or Harness compiler outputs directly; change their source and regenerate them.",
      rationale: "Direct edits are overwritten and create cross-session drift.",
      scope: { include: ["**/generated/**", ".harness/generated/**"], exclude: [], boundaries: ["generated-code"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable", configPath: "AGENTS.md" }],
      verification: { commands: [["harness-automation", "drift", "--project", "."]], passCriteria: "Generated output hashes match the Harness manifest." },
    }, owner, sources),
  ];
}

function typescriptNaming(owner: string, sources: SourceSnapshot[]): PolicyRule {
  return rule({
    id: "typescript-naming",
    title: "TypeScript naming",
    statement: "Use camelCase for variables, functions, parameters, methods, and local properties; PascalCase for classes, interfaces, types, enums, and React components; UPPER_SNAKE_CASE is allowed only for module constants.",
    rationale: "A deterministic naming gate prevents fresh sessions from alternating between camelCase and snake_case.",
    scope: { include: ["**/*.ts", "**/*.tsx"], exclude: ["**/*.d.ts", "**/generated/**", ".harness/**"], boundaries: ["code"] },
    formalization: "deterministic",
    severity: "error",
    targets: [{ kind: "linter", adapter: "harness-typescript-ast" }],
    verification: { commands: [["harness-automation", "check", "--project", "."]], passCriteria: "The AST naming verifier passes the invalid fixture test and the repository contains no violations." },
    examples: { valid: ["const userId = 1", "class UserService {}"], invalid: ["const user_id = 1", "class user_service {}"] },
  }, owner, sources);
}

function profileRules(profile: StackProfile, stacks: Stack[], owner: string, sources: SourceSnapshot[]): PolicyRule[] {
  const rules: PolicyRule[] = [];
  if (stacks.includes("typescript")) rules.push(typescriptNaming(owner, sources));

  if (profile === "full-typescript") {
    rules.push(rule({
      id: "typescript-boundary-naming",
      title: "TypeScript boundary naming",
      statement: "Use lower camelCase in TypeScript and external JSON. Use snake_case in PostgreSQL and map it explicitly with Prisma @map/@@map. tRPC routers and procedures use camelCase.",
      rationale: "Each boundary has one representation and an explicit mapping point.",
      scope: { include: ["**/*.ts", "**/*.tsx", "**/*.prisma"], exclude: ["**/generated/**"], boundaries: ["api", "database"] },
      formalization: "cognitive",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable" }, { kind: "schema-validator", adapter: "prisma" }],
      verification: { commands: [["node_modules/.bin/prisma", "validate"]], passCriteria: "The locally installed Prisma CLI validates and review confirms every database-name difference is explicitly mapped." },
    }, owner, sources));
  }

  if (stacks.includes("python")) {
    rules.push(rule({
      id: "python-naming",
      title: "Python naming",
      statement: "Use snake_case for Python variables, functions, parameters, modules, and fields; PascalCase for classes; UPPER_SNAKE_CASE only for constants.",
      rationale: "Python follows its native convention while mappings make TypeScript boundaries explicit.",
      scope: { include: ["**/*.py"], exclude: ["**/migrations/**", "**/generated/**", ".venv/**"], boundaries: ["code"] },
      formalization: "deterministic",
      severity: "error",
      targets: [{ kind: "linter", adapter: "harness-python-ast", configPath: ".harness/generated/check_python_naming.py" }],
      verification: { commands: [["python3", ".harness/generated/check_python_naming.py", "."]], passCriteria: "Python AST naming verifier rejects its invalid fixture and passes the repository." },
      examples: { valid: ["user_id = 1", "class UserService: ..."], invalid: ["userId = 1", "class user_service: ..."] },
    }, owner, sources));
  }

  if (profile === "python-data-ai") {
    rules.push(rule({
      id: "python-json-boundary",
      title: "Python to TypeScript JSON boundary",
      statement: "Python internals use snake_case; external JSON uses camelCase. Pydantic aliases are the only translation point, and Django models keep PostgreSQL identifiers snake_case.",
      rationale: "Explicit boundary mapping keeps both ecosystems idiomatic without ambiguous field names.",
      scope: { include: ["**/*.py", "**/*.ts", "**/*.tsx"], exclude: ["**/generated/**"], boundaries: ["api", "database", "queue"] },
      formalization: "cognitive",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable" }, { kind: "schema-validator", adapter: "pydantic" }],
      verification: { commands: [["python3", "manage.py", "check"]], passCriteria: "Django check passes and contract tests assert the camelCase JSON representation." },
    }, owner, sources));
    rules.push(rule({
      id: "django-migration-discipline",
      title: "Django migration discipline",
      statement: "Django model changes must include reviewed migrations; commit and CI checks must report no missing migrations before merge.",
      rationale: "Schema drift between fresh sessions is a contract failure, not a local implementation detail.",
      scope: { include: ["**/*.py"], exclude: [".venv/**"], boundaries: ["database"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "schema-validator", adapter: "django", command: ["python3", "manage.py", "makemigrations", "--check", "--dry-run"] }],
      verification: { commands: [["python3", "manage.py", "check"], ["python3", "manage.py", "makemigrations", "--check", "--dry-run"]], passCriteria: "Django system checks pass and no unapplied model changes require a new migration." },
    }, owner, sources));
    rules.push(rule({
      id: "celery-task-contracts",
      title: "Celery task contracts",
      statement: "Celery task names are stable contracts; payloads use explicit Pydantic schemas, retries are bounded and intentional, and producers/consumers change together.",
      rationale: "Queued work crosses processes and sessions, so implicit payload assumptions create delayed failures.",
      scope: { include: ["**/*.py"], exclude: ["**/migrations/**"], boundaries: ["queue"] },
      formalization: "cognitive",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable" }, { kind: "contract-test", adapter: "project-tests" }],
      verification: { commands: [], passCriteria: "Review and contract tests confirm stable names, versioned payloads, and explicit retry behavior." },
    }, owner, sources));
  }

  if (stacks.includes("go")) {
    rules.push(rule({
      id: "go-naming",
      title: "Go naming",
      statement: "Use Go mixedCaps for identifiers, PascalCase for exported identifiers, and camelCase for unexported identifiers. Do not encode word boundaries with underscores.",
      rationale: "A Go AST gate prevents Python or database naming from leaking into Go source.",
      scope: { include: ["**/*.go"], exclude: ["**/generated/**", "**/*.pb.go"], boundaries: ["code"] },
      formalization: "deterministic",
      severity: "error",
      targets: [{ kind: "linter", adapter: "harness-go-ast", configPath: ".harness/generated/check_go_naming.go" }],
      verification: { commands: [["go", "run", ".harness/generated/check_go_naming.go", "."]], passCriteria: "Go AST naming verifier rejects its invalid fixture and passes the repository." },
      examples: { valid: ["var userID string", "func LoadUser() {}"], invalid: ["var user_id string"] },
    }, owner, sources));
  }

  if (profile === "go-performance") {
    rules.push(rule({
      id: "grpc-database-boundary",
      title: "Go RPC and database boundary naming",
      statement: "Proto fields and PostgreSQL columns use snake_case; protobuf JSON uses lowerCamelCase; generated Go and application Go use mixedCaps; TypeScript uses camelCase. Generated bindings are never edited.",
      rationale: "The schema/compiler boundary owns every naming conversion.",
      scope: { include: ["**/*.proto", "**/*.sql", "**/*.go", "**/*.ts", "**/*.tsx"], exclude: ["**/generated/**", "**/*.pb.go"], boundaries: ["rpc", "database", "generated-code"] },
      formalization: "cognitive",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable" }, { kind: "schema-validator", adapter: "buf" }],
      verification: { commands: [["go", "test", "./..."]], passCriteria: "Generated bindings are current and Go contract tests pass." },
    }, owner, sources));
    rules.push(rule({
      id: "go-generated-schema-consistency",
      title: "Go generated schema consistency",
      statement: "Proto, SQL, or ent schema is the source of truth. Generated Go and TypeScript bindings must be regenerated together and never edited directly.",
      rationale: "A single schema source prevents different sessions from hand-maintaining incompatible bindings.",
      scope: { include: ["**/*.proto", "**/*.sql", "**/ent/schema/*.go", "**/*.go", "**/*.ts"], exclude: ["**/generated/**", "**/*.pb.go"], boundaries: ["rpc", "database", "generated-code"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "schema-validator", adapter: "buf-sqlc-ent" }, { kind: "contract-test", adapter: "go-test" }],
      verification: { commands: [["harness-automation", "check", "--project", ".", "--mode", "commit"]], passCriteria: "Configured proto and data generators validate and repository tests pass without generated drift." },
    }, owner, sources));
  }

  if (stacks.includes("kubernetes")) {
    rules.push(rule({
      id: "kubernetes-delivery",
      title: "Kubernetes delivery validation",
      statement: "Kubernetes manifests and overlays must be schema-valid, contain no plaintext secrets, and use immutable image references before merge.",
      rationale: "Deployment configuration is executable production code and must remain consistent across Agent sessions.",
      scope: { include: ["k8s/**/*.yaml", "deploy/**/*.yaml", "manifests/**/*.yaml", "**/Chart.yaml", "**/kustomization.yaml"], exclude: ["**/secrets.local.yaml"], boundaries: ["deployment"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "schema-validator", adapter: "kubeconform" }, { kind: "agent-instruction", adapter: "portable" }],
      verification: { commands: [["harness-automation", "check", "--project", ".", "--mode", "commit"]], passCriteria: "The detected Kubernetes validator passes; unavailable validators are reported as blocked." },
    }, owner, sources));
  }

  return rules;
}

function deliveryProfileRules(
  profiles: DeliveryProfile[],
  owner: string,
  sources: SourceSnapshot[],
): PolicyRule[] {
  if (!profiles.includes("worktree-delivery")) return [];
  return [rule({
    id: "worktree-delivery-gate",
    title: "Worktree delivery gate",
    statement: "Run the host-local worktree audit before implementation and delivery; persistent lifecycle changes require an exact-hash plan and durable receipt.",
    rationale: "One shared lease and cleanup protocol prevents duplicate worktrees and cross-session delivery drift.",
    scope: { include: ["**/*"], exclude: [".git/**"], boundaries: ["code", "deployment"] },
    formalization: "procedural",
    severity: "error",
    targets: [{ kind: "custom-command", adapter: "harness-worktree", command: ["harness-automation", "worktree", "audit", "--project", "."] }],
    verification: { commands: [], passCriteria: "The local workspace audit is available and passing; CI reports host visibility as blocked." },
  }, owner, sources)];
}

function domainProfileRules(
  profiles: DomainProfile[],
  owner: string,
  sources: SourceSnapshot[],
): PolicyRule[] {
  if (!profiles.includes("game-development")) return [];
  return [
    rule({
      id: "game-deterministic-replay",
      title: "Deterministic simulation and replay",
      statement: "Changes to simulation logic must record seed, inputs, deterministic state hash, and replay evidence in project-owned tests.",
      rationale: "Gameplay regressions cannot be reproduced across sessions without deterministic evidence.",
      scope: { include: ["**/*"], exclude: ["**/generated/**"], boundaries: ["code"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "contract-test", adapter: "project-tests" }],
      verification: { commands: [], passCriteria: "A project-owned replay test reproduces the accepted state hash from a fixed seed and input stream." },
    }, owner, sources),
    rule({
      id: "game-real-engine-smoke",
      title: "Real engine smoke evidence",
      statement: "Engine-facing changes require a smoke run in the real engine/runtime, not only mocked unit tests.",
      rationale: "Serialization, lifecycle, rendering, and engine integration failures are invisible to isolated mocks.",
      scope: { include: ["**/*"], exclude: ["**/generated/**"], boundaries: ["code", "deployment"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "contract-test", adapter: "project-engine" }],
      verification: { commands: [], passCriteria: "The repository records the approved real-engine smoke command and its successful evidence." },
    }, owner, sources),
    rule({
      id: "game-target-performance",
      title: "Target-device performance budget",
      statement: "Performance-sensitive changes must state the target device and approved frame-time, P95/P99 latency, memory, and GC budgets.",
      rationale: "Desktop averages do not establish performance on the intended device.",
      scope: { include: ["**/*"], exclude: ["**/generated/**"], boundaries: ["code", "deployment"] },
      formalization: "cognitive",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable" }],
      verification: { commands: [], passCriteria: "Owner review confirms target-device evidence and explicit budgets." },
    }, owner, sources),
    rule({
      id: "game-content-provenance",
      title: "Content provenance",
      statement: "Every shipped content asset must record origin, license, attribution obligations, and AI-generation status where applicable.",
      rationale: "Asset provenance and legal disposition require explicit evidence that code-only checks cannot infer.",
      scope: { include: ["**/*"], exclude: ["**/generated/**"], boundaries: ["deployment"] },
      formalization: "cognitive",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable" }],
      verification: { commands: [], passCriteria: "Owner or legal review confirms the repository provenance record." },
    }, owner, sources),
  ];
}

function qualityProfileRules(
  profiles: QualityProfile[],
  discovery: Discovery,
  owner: string,
  sources: SourceSnapshot[],
): PolicyRule[] {
  if (!profiles.includes("eval-driven-development")) return [];
  const commands = Object.entries(discovery.commands)
    .filter(([id]) => id.startsWith("eval:"))
    .map(([, command]) => command);
  return [
    rule({
      id: "eval-contract-before-implementation",
      title: "Evaluation contract before implementation",
      statement: "Define representative tasks, graders, an implementation-before baseline, and an explicit target in evals/evals.json before implementing an evaluated capability.",
      rationale: "An approved evaluation contract turns ambiguous success criteria into stable cross-session development evidence.",
      scope: { include: ["evals/**/*", "docs/evals/**/*"], exclude: [], boundaries: ["evaluation"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable", configPath: ".harness/generated/effective-policy.md" }],
      verification: { commands: [], passCriteria: "The approved eval contract and every referenced source exist and match intake hashes." },
    }, owner, sources),
    rule({
      id: "eval-regression-gate",
      title: "Evaluation regression gate",
      statement: "Run every approved evaluation suite in CI and reject delivery when its project-owned runner does not meet the contract target.",
      rationale: "A repeatable project runner makes quality regressions visible across model, prompt, tool, and implementation changes.",
      scope: { include: ["evals/**/*", "**/*"], exclude: [".harness/eval-runs/**"], boundaries: ["evaluation"] },
      formalization: "deterministic",
      severity: "error",
      targets: commands.map((command, index) => ({ kind: "evaluation" as const, adapter: `project-eval-${index + 1}`, command })),
      verification: { commands, passCriteria: "Every approved evaluation runner exits successfully in `check --mode ci`." },
    }, owner, sources),
    rule({
      id: "eval-evidence-provenance",
      title: "Evaluation evidence provenance",
      statement: "Keep evaluation tasks, baselines, and grader calibration evidence in approved repository sources protected by SHA-256 drift checks.",
      rationale: "Changing the measurement while changing the implementation makes quality comparisons unreliable.",
      scope: { include: ["evals/**/*", "docs/evals/**/*"], exclude: [".harness/eval-runs/**"], boundaries: ["evaluation"] },
      formalization: "procedural",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable" }],
      verification: { commands: [], passCriteria: "All referenced evidence remains inside the repository and matches its approved intake hash." },
    }, owner, sources),
    rule({
      id: "eval-judge-calibration",
      title: "Model grader calibration",
      statement: "Treat model graders as guidance unless human calibration evidence is recorded; only calibrated model graders may participate in a hard gate.",
      rationale: "Uncalibrated model judgments are stochastic opinions, not sound deterministic enforcement.",
      scope: { include: ["evals/**/*", "docs/evals/**/*"], exclude: [], boundaries: ["evaluation"] },
      formalization: "cognitive",
      severity: "error",
      targets: [{ kind: "agent-instruction", adapter: "portable" }],
      verification: { commands: [], passCriteria: "Human review confirms that every gating model grader cites calibration evidence." },
    }, owner, sources),
  ];
}

export function compilePolicy(args: {
  projectRoot: string;
  owner: string;
  intake: Intake;
  discovery: Discovery;
  profile?: StackProfile;
  stacks?: Stack[];
  deliveryProfiles?: DeliveryProfile[];
  domainProfiles?: DomainProfile[];
  qualityProfiles?: QualityProfile[];
}): PolicyDocument {
  const profile = args.profile ?? args.discovery.profile;
  if (profile !== "custom" && args.stacks?.length) {
    throw new Error("STACK_OVERRIDE_REQUIRES_CUSTOM_PROFILE: use --profile custom with explicit --stack values");
  }
  const stacks = normalizeStackIds(
    profile === "custom"
      ? args.stacks ?? []
      : stacksForProfile(profile, args.discovery.stacks),
  );
  if (stacks.length === 0) {
    throw new Error("STACK_SELECTION_REQUIRED: use --profile custom with one or more explicit --stack values");
  }
  const adapters = new Map(args.discovery.agents.map(({ id, capabilities }) => [id, { id, capabilities }]));
  const deliveryProfiles = validateProfiles(args.deliveryProfiles ?? [], DELIVERY_PROFILES, "DELIVERY");
  const domainProfiles = validateProfiles(args.domainProfiles ?? [], DOMAIN_PROFILES, "DOMAIN");
  const qualityProfiles = validateProfiles(args.qualityProfiles ?? [], QUALITY_PROFILES, "QUALITY");
  adapters.set("portable", {
    id: "portable",
    capabilities: ["root-instructions", "scoped-instructions", "structured-output"],
  });
  adapters.set("claude-code", {
    id: "claude-code",
    capabilities: ["root-instructions", "scoped-instructions", "instruction-imports", "session-hooks", "mcp"],
  });
  adapters.set("codex", {
    id: "codex",
    capabilities: ["root-instructions", "scoped-instructions", "mcp", "structured-output"],
  });
  return {
    schemaVersion: "2.0",
    project: {
      name: basename(args.projectRoot),
      owner: args.owner,
      phase: "design-approved",
      stacks,
      deliveryProfiles,
      domainProfiles,
      qualityProfiles,
    },
    sources: args.intake.sources,
    agents: {
      portableInstructionFile: "AGENTS.md",
      adapters: [...adapters.values()],
    },
    policies: [
      ...commonRules(args.owner, args.intake.sources),
      ...profileRules(profile, stacks, args.owner, args.intake.sources),
      ...deliveryProfileRules(deliveryProfiles, args.owner, args.intake.sources),
      ...domainProfileRules(domainProfiles, args.owner, args.intake.sources),
      ...qualityProfileRules(qualityProfiles, args.discovery, args.owner, args.intake.sources),
    ],
  };
}

export function renderEffectivePolicy(policy: PolicyDocument, digest: string): string {
  const stackCoverage = policy.project.stacks.map((stack) => {
    const support = stackAdapterSupport(stack);
    return support === "none"
      ? `- \`${stack}\`: no built-in adapter; generic policies apply and stack-specific enforcement is blocked.`
      : `- \`${stack}\`: built-in ${support} support.`;
  });
  const sections = policy.policies.map((item, index) => {
    const verification = item.verification.commands.length > 0
      ? item.verification.commands.map((command) => `\`${command.join(" ")}\``).join(", ")
      : "owner review";
    return [
      `## ${index + 1}. ${item.title} (${item.id})`,
      "",
      item.statement,
      "",
      `- Severity: ${item.severity}`,
      `- Formalization: ${item.formalization}`,
      `- Verify with: ${verification}`,
    ].join("\n");
  });
  return [
    "# Effective Engineering Policy",
    "",
    `Policy digest: \`${digest}\``,
    `Owner: ${policy.project.owner}`,
    `Stack: ${policy.project.stacks.join(", ")}`,
    "",
    "This file is generated. Change `.harness/policy.yaml`, obtain owner approval, and recompile instead of editing this file.",
    "",
    "## Stack adapter coverage",
    "",
    ...stackCoverage,
    "",
    ...sections,
    "",
  ].join("\n");
}

export function managedInstructionBlock(digest: string): string {
  return [
    MANAGED_START,
    "## Harness engineering continuity",
    "",
    `Effective policy digest: \`${digest}\``,
    "",
    "Before editing code in a new session:",
    "",
    "1. Run `harness-automation context --project .` and read `.harness/generated/effective-policy.md`.",
    "2. Search for the existing implementation and identify the owning module before adding a new one.",
    "3. Treat shared APIs, RPC, database schemas, queues, and generated code as contracts.",
    "4. Run `harness-automation check --project .` before declaring work complete.",
    "5. Never edit `.harness/generated/**` or this managed block directly.",
    "",
    MANAGED_END,
  ].join("\n");
}

export function upsertManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error("MALFORMED_MANAGED_BLOCK: instruction file has unmatched Harness markers");
  }
  if (start === -1) {
    const prefix = existing.length === 0 ? "" : `${existing.replace(/\s+$/u, "")}\n\n`;
    return `${prefix}${block}\n`;
  }
  const after = end + MANAGED_END.length;
  return `${existing.slice(0, start)}${block}${existing.slice(after)}`.replace(/\s+$/u, "") + "\n";
}

export const PYTHON_NAMING_CHECKER = String.raw`#!/usr/bin/env python3
import ast
import pathlib
import re
import sys

SNAKE = re.compile(r"^(?:_?[a-z][a-z0-9]*(?:_[a-z0-9]+)*|_[a-z][a-z0-9_]*|__[a-z0-9_]+__)$")
PASCAL = re.compile(r"^[A-Z][A-Za-z0-9]*$")
UPPER = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$")
IGNORE = {"migrations", ".venv", "venv", "generated", ".harness", "node_modules"}

def check_source(source, name):
    errors = []
    try:
        tree = ast.parse(source, filename=name)
    except SyntaxError as exc:
        return [f"{name}:{exc.lineno}: syntax error: {exc.msg}"]
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not SNAKE.match(node.name):
            errors.append(f"{name}:{node.lineno}: function '{node.name}' must be snake_case")
        if isinstance(node, ast.ClassDef) and not PASCAL.match(node.name):
            errors.append(f"{name}:{node.lineno}: class '{node.name}' must be PascalCase")
        if isinstance(node, ast.arg) and node.arg not in {"self", "cls"} and not SNAKE.match(node.arg):
            errors.append(f"{name}:{node.lineno}: parameter '{node.arg}' must be snake_case")
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                for child in ast.walk(target):
                    if isinstance(child, ast.Name) and not (SNAKE.match(child.id) or UPPER.match(child.id)):
                        errors.append(f"{name}:{child.lineno}: variable '{child.id}' must be snake_case")
    return errors

if "--self-test" in sys.argv:
    failures = check_source("def loadUser(userId):\n    return userId\n", "fixture.py")
    if not failures:
        print("invalid fixture unexpectedly passed", file=sys.stderr)
        sys.exit(2)
    print("\n".join(failures), file=sys.stderr)
    sys.exit(1)

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
errors = []
for path in root.rglob("*.py"):
    if any(part in IGNORE for part in path.parts):
        continue
    try:
        errors.extend(check_source(path.read_text(encoding="utf-8"), str(path)))
    except UnicodeDecodeError:
        errors.append(f"{path}: not UTF-8")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
` + "\n";

export const GO_NAMING_CHECKER = String.raw`// Code generated by harness-automation. DO NOT EDIT.
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

func invalid(name string) bool {
	if name == "_" || strings.HasPrefix(name, "Test") || strings.HasPrefix(name, "Benchmark") || strings.HasPrefix(name, "Example") { return false }
	if strings.Contains(name, "_") { return true }
	first, _ := utf8First(name)
	return first != 0 && !unicode.IsLetter(first)
}

func utf8First(value string) (rune, int) {
	for _, r := range value { return r, 1 }
	return 0, 0
}

func checkFile(path string, source any) []string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, source, 0)
	if err != nil { return []string{err.Error()} }
	errors := []string{}
	ast.Inspect(file, func(node ast.Node) bool {
		ident, ok := node.(*ast.Ident)
		if ok && ident.Obj != nil && invalid(ident.Name) {
			position := fset.Position(ident.Pos())
			errors = append(errors, fmt.Sprintf("%s:%d: identifier %q must use mixedCaps", position.Filename, position.Line, ident.Name))
		}
		return true
	})
	return errors
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--self-test" {
		errors := checkFile("fixture.go", "package fixture\nvar user_id string\n")
		if len(errors) == 0 { fmt.Fprintln(os.Stderr, "invalid fixture unexpectedly passed"); os.Exit(2) }
		fmt.Fprintln(os.Stderr, strings.Join(errors, "\n")); os.Exit(1)
	}
	root := "."
	if len(os.Args) > 1 { root = os.Args[1] }
	errors := []string{}
	filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil { return err }
		if entry.IsDir() {
			name := entry.Name()
			if name == ".git" || name == ".harness" || name == "vendor" || name == "generated" { return filepath.SkipDir }
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".pb.go") {
			errors = append(errors, checkFile(path, nil)...)
		}
		return nil
	})
	if len(errors) > 0 { fmt.Fprintln(os.Stderr, strings.Join(errors, "\n")); os.Exit(1) }
}
`;
