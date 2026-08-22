import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashObject } from "../v2/fs.js";
import { commandJson } from "../worktree/provider.js";

type Json = Record<string, unknown>;

export interface GitHubGovernanceReport {
  schemaVersion: "github-governance-audit/1.0";
  scope: { repository: string; organization?: string };
  repository: Json;
  rulesets: Json[];
  branchProtection: Json | null;
  checks: Json;
  codeowners: Json;
  actions: Json;
  environments: Json[];
  project: Json;
  organization?: Json;
  capabilityLimits: string[];
  blockers: string[];
  warnings: string[];
  unavailable: string[];
  status: "pass" | "blocked";
  observedHash: string;
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function commandText(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
  return result.stdout.trim();
}

function githubRepository(projectRoot: string): { owner: string; name: string; slug: string; head: string } {
  const remote = commandText(projectRoot, "git", ["remote", "get-url", "origin"]);
  const matched = remote.match(/github\.com(?::|\/)([^/:\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (!matched) throw new Error(`GITHUB_REMOTE_REQUIRED: origin is not a github.com repository: ${remote}`);
  const owner = matched[1];
  const name = matched[2].replace(/\.git$/u, "");
  if (!owner || !name) throw new Error(`GITHUB_REMOTE_REQUIRED: origin is not a repository: ${remote}`);
  return { owner, name, slug: `${owner}/${name}`, head: commandText(projectRoot, "git", ["rev-parse", "HEAD"]) };
}

function isNotFound(error: string | undefined): boolean {
  return /\b404\b|not found/iu.test(error ?? "");
}

function sanitized(error: string | undefined): string {
  return (error ?? "unknown error").replace(/(token|authorization)\s*[:=]\s*\S+/giu, "$1=[redacted]").slice(0, 300);
}

function localWorkflows(projectRoot: string): { files: string[]; unpinnedUses: string[]; leastPrivilegeDeclared: boolean } {
  const directory = join(projectRoot, ".github", "workflows");
  if (!existsSync(directory)) return { files: [], unpinnedUses: [], leastPrivilegeDeclared: false };
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const unpinnedUses: string[] = [];
  let leastPrivilegeDeclared = false;
  for (const file of files) {
    const content = readFileSync(join(directory, file), "utf8");
    if (/^permissions\s*:/mu.test(content)) leastPrivilegeDeclared = true;
    for (const match of content.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*$/gmu)) {
      const reference = match[1];
      if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
      const revision = reference.split("@").at(-1) ?? "";
      if (!/^[a-f0-9]{40}$/iu.test(revision)) unpinnedUses.push(`${file}:${reference}`);
    }
  }
  return { files, unpinnedUses: sorted(unpinnedUses), leastPrivilegeDeclared };
}

function localCodeowners(projectRoot: string): Json {
  const path = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].find((candidate) => existsSync(join(projectRoot, candidate)));
  if (!path) return { exists: false, syntaxAvailable: true, owners: [], resolution: "not-configured" };
  const owners = readFileSync(join(projectRoot, path), "utf8").split(/\r?\n/u)
    .flatMap((line) => line.replace(/#.*/u, "").trim().split(/\s+/u).slice(1))
    .filter((owner) => owner.startsWith("@"));
  return { exists: true, path, syntaxAvailable: true, owners: sorted(owners), resolution: "not-queried" };
}

function ruleDetails(root: string, slug: string, list: unknown[], unavailable: string[]): Json[] {
  return array(list).map((item) => record(item)).map((item) => {
    const id = item.id;
    if (typeof id !== "number") return { ...item, rules: [] };
    const result = commandJson(root, "gh", ["api", "--method", "GET", `repos/${slug}/rulesets/${id}`]);
    if (!result.ok) {
      unavailable.push(`ruleset ${id}: ${sanitized(result.error)}`);
      return { ...item, rules: [] };
    }
    return record(result.value);
  }).sort((left, right) => String(left.name ?? left.id).localeCompare(String(right.name ?? right.id)));
}

function hasRule(rulesets: Json[], type: string): boolean {
  return rulesets.some((ruleset) => text(ruleset.enforcement) === "active" && array(ruleset.rules)
    .some((rule) => text(record(rule).type) === type));
}

function defaultBranchRulesets(rulesets: Json[], defaultBranch: string): Json[] {
  return rulesets.filter((ruleset) => {
    if (text(ruleset.enforcement) !== "active" || text(ruleset.target) !== "branch") return false;
    const include = array(record(record(ruleset.conditions).ref_name).include).flatMap(text);
    return include.length === 0 || include.includes(defaultBranch) || include.includes("~DEFAULT_BRANCH");
  });
}

function requiredRuleChecks(rulesets: Json[], protection: Json | null): string[] {
  const contexts = array(record(record(protection ?? {}).required_status_checks).contexts)
    .flatMap((entry) => text(entry) ? [text(entry)!] : []);
  for (const ruleset of rulesets) {
    for (const rule of array(ruleset.rules)) {
      const value = record(rule);
      if (text(value.type) !== "required_status_checks") continue;
      const parameters = record(value.parameters);
      for (const check of array(parameters.required_status_checks)) {
        const context = text(record(check).context);
        if (context) contexts.push(context);
      }
    }
  }
  return sorted(contexts);
}

function projectObservation(root: string, slug: string, unavailable: string[], blockers: string[]): Json {
  const path = join(root, ".github", "project-workflow.json");
  if (!existsSync(path)) return { configured: false, mapping: "not-configured" };
  let config: Json;
  try {
    config = record(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    unavailable.push("project mapping: invalid .github/project-workflow.json");
    return { configured: true, mapping: "invalid" };
  }
  if (text(config.repo) && text(config.repo) !== slug) blockers.push(`PROJECT_MAPPING_DRIFT: configured ${text(config.repo)}, observed ${slug}`);
  const project = record(config.project);
  const owner = text(project.owner);
  const number = project.number;
  if (!owner || typeof number !== "number") return { configured: true, mapping: "incomplete", owner, number };
  const result = commandJson(root, "gh", ["project", "view", String(number), "--owner", owner, "--format", "json"]);
  if (!result.ok) {
    unavailable.push(`project mapping: ${sanitized(result.error)}`);
    return { configured: true, mapping: "unavailable", owner, number };
  }
  return { configured: true, mapping: "available", owner, number, fields: Object.keys(record(result.value)).sort() };
}

function organizationObservation(root: string, organization: string, unavailable: string[]): Json {
  const repositories = commandJson(root, "gh", ["api", "--method", "GET", "--paginate", "--slurp", `orgs/${organization}/repos?per_page=100`]);
  if (!repositories.ok) {
    unavailable.push(`organization repositories: ${sanitized(repositories.error)}`);
    return { login: organization, available: false, repositories: [] };
  }
  const pages = array(repositories.value);
  if (!pages.every(Array.isArray)) {
    unavailable.push("organization repositories: pagination response was incomplete");
    return { login: organization, available: false, repositories: [] };
  }
  const rulesets = commandJson(root, "gh", ["api", "--method", "GET", `orgs/${organization}/rulesets`]);
  if (!rulesets.ok) unavailable.push(`organization rulesets: ${sanitized(rulesets.error)}`);
  const repos = pages.flatMap((page) => array(page)).map((item) => {
    const repository = record(item);
    const name = text(repository.full_name);
    const defaultBranch = text(repository.default_branch);
    const effectiveRulesets = name
      ? commandJson(root, "gh", ["api", "--method", "GET", `repos/${name}/rulesets`])
      : { ok: false, error: "repository name unavailable" };
    if (!effectiveRulesets.ok) unavailable.push(`organization repository rulesets ${name ?? "unknown"}: ${sanitized(effectiveRulesets.error)}`);
    const protection = name && defaultBranch
      ? commandJson(root, "gh", ["api", "--method", "GET", `repos/${name}/branches/${defaultBranch}/protection`])
      : { ok: false, error: "default branch unavailable" };
    if (!protection.ok && !isNotFound(protection.error)) unavailable.push(`organization branch protection ${name ?? "unknown"}: ${sanitized(protection.error)}`);
    return {
      id: repository.id,
      name,
      visibility: text(repository.visibility) ?? (bool(repository.private) ? "private" : "public"),
      defaultBranch,
      ownerType: text(record(repository.owner).type),
      defaultBranchProtected: protection.ok,
      effectiveRulesets: effectiveRulesets.ok ? array(effectiveRulesets.value).map(record).sort((left, right) => String(left.name).localeCompare(String(right.name))) : [],
    };
  }).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return { login: organization, available: rulesets.ok, repositories: repos, rulesets: array(rulesets.value).map(record).sort((left, right) => String(left.name).localeCompare(String(right.name))) };
}

export function auditGitHubGovernance(input: { projectRoot: string; organization?: string }): GitHubGovernanceReport {
  const projectRoot = resolve(input.projectRoot);
  if (input.organization && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/u.test(input.organization)) {
    throw new Error("INVALID_ORGANIZATION: GitHub organization name is invalid");
  }
  const local = githubRepository(projectRoot);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const unavailable: string[] = [];
  const repoResult = commandJson(projectRoot, "gh", ["api", "--method", "GET", `repos/${local.slug}`]);
  if (!repoResult.ok) {
    unavailable.push(`repository: ${sanitized(repoResult.error)}`);
    const report = {
      schemaVersion: "github-governance-audit/1.0" as const,
      scope: { repository: local.slug, ...(input.organization ? { organization: input.organization } : {}) },
      repository: { slug: local.slug, head: local.head, available: false }, rulesets: [], branchProtection: null,
      checks: { required: [], latest: [] }, codeowners: localCodeowners(projectRoot), actions: { workflows: localWorkflows(projectRoot).files }, environments: [], project: { configured: false },
      capabilityLimits: ["GitHub Team and Enterprise-only settings are reported only when the current token can read them"], blockers, warnings, unavailable: sorted(unavailable), status: "blocked" as const, observedHash: "",
    };
    return { ...report, observedHash: hashObject({ ...report, observedHash: undefined }) };
  }
  const repo = record(repoResult.value);
  const defaultBranch = text(repo.default_branch) ?? "main";
  const rulesetList = commandJson(projectRoot, "gh", ["api", "--method", "GET", `repos/${local.slug}/rulesets`]);
  if (!rulesetList.ok) unavailable.push(`repository rulesets: ${sanitized(rulesetList.error)}`);
  const rulesets = ruleDetails(projectRoot, local.slug, array(rulesetList.value), unavailable);
  const branch = commandJson(projectRoot, "gh", ["api", "--method", "GET", `repos/${local.slug}/branches/${defaultBranch}/protection`]);
  const branchProtection = branch.ok ? record(branch.value) : isNotFound(branch.error) ? null : (unavailable.push(`branch protection: ${sanitized(branch.error)}`), null);
  const branchRulesets = defaultBranchRulesets(rulesets, defaultBranch);
  const requiredChecks = requiredRuleChecks(branchRulesets, branchProtection);
  const protection = record(branchProtection ?? {});
  const prConfigured = Boolean(protection.required_pull_request_reviews) || hasRule(branchRulesets, "pull_request");
  const forceBlocked = bool(record(protection.allow_force_pushes).enabled) === false || hasRule(branchRulesets, "non_fast_forward");
  const deletionBlocked = bool(record(protection.allow_deletions).enabled) === false || hasRule(branchRulesets, "deletion");
  if (!branchProtection && !(prConfigured && forceBlocked && deletionBlocked)) blockers.push(`DEFAULT_BRANCH_UNPROTECTED: ${defaultBranch}`);
  if (!prConfigured) blockers.push(`PULL_REQUEST_RULE_MISSING: ${defaultBranch}`);
  if (requiredChecks.length === 0) blockers.push(`REQUIRED_CHECK_RULE_MISSING: ${defaultBranch}`);
  if (!forceBlocked) blockers.push(`FORCE_PUSH_ALLOWED: ${defaultBranch}`);
  if (!deletionBlocked) blockers.push(`BRANCH_DELETION_ALLOWED: ${defaultBranch}`);
  const checksResult = commandJson(projectRoot, "gh", ["api", "--method", "GET", `repos/${local.slug}/commits/${defaultBranch}/check-runs`]);
  const latest = checksResult.ok ? array(record(checksResult.value).check_runs).map((item) => ({ name: text(record(item).name), conclusion: text(record(item).conclusion) })).sort((left, right) => String(left.name).localeCompare(String(right.name))) : [];
  if (!checksResult.ok) unavailable.push(`latest checks: ${sanitized(checksResult.error)}`);
  const observedChecks = new Map(latest.map((check) => [check.name, check.conclusion]));
  for (const check of requiredChecks) {
    if (!observedChecks.has(check)) blockers.push(`REQUIRED_CHECK_MISSING: ${check}`);
    else if (observedChecks.get(check) !== "success") warnings.push(`REQUIRED_CHECK_NOT_PASSING: ${check}`);
  }
  const actionsResult = commandJson(projectRoot, "gh", ["api", "--method", "GET", `repos/${local.slug}/actions/permissions`]);
  const workflowPermissions = commandJson(projectRoot, "gh", ["api", "--method", "GET", `repos/${local.slug}/actions/permissions/workflow`]);
  if (!actionsResult.ok) unavailable.push(`Actions settings: ${sanitized(actionsResult.error)}`);
  if (!workflowPermissions.ok) unavailable.push(`Actions workflow permissions: ${sanitized(workflowPermissions.error)}`);
  const workflows = localWorkflows(projectRoot);
  const actions = record(actionsResult.value);
  const shaPinnedRequired = bool(actions.sha_pinned_required) === true;
  if (shaPinnedRequired && workflows.unpinnedUses.length > 0) blockers.push(...workflows.unpinnedUses.map((entry) => `UNPINNED_ACTION: ${entry}`));
  else if (workflows.unpinnedUses.length > 0) warnings.push(...workflows.unpinnedUses.map((entry) => `UNPINNED_ACTION_OBSERVED: ${entry}`));
  const environmentsResult = commandJson(projectRoot, "gh", ["api", "--method", "GET", `repos/${local.slug}/environments`]);
  if (!environmentsResult.ok) unavailable.push(`environments: ${sanitized(environmentsResult.error)}`);
  const project = projectObservation(projectRoot, local.slug, unavailable, blockers);
  const owner = record(repo.owner);
  if (text(owner.type) === "User") warnings.push("USER_OWNED_REPOSITORY: organization Team controls do not apply");
  const organization = input.organization ? organizationObservation(projectRoot, input.organization, unavailable) : undefined;
  const report = {
    schemaVersion: "github-governance-audit/1.0" as const,
    scope: { repository: local.slug, ...(input.organization ? { organization: input.organization } : {}) },
    repository: { slug: local.slug, id: repo.id, owner: text(owner.login), ownerType: text(owner.type), visibility: text(repo.visibility) ?? (bool(repo.private) ? "private" : "public"), defaultBranch, head: local.head },
    rulesets,
    branchProtection,
    checks: { required: requiredChecks, latest },
    codeowners: localCodeowners(projectRoot),
    actions: { enabled: bool(actions.enabled), allowedActions: text(actions.allowed_actions), shaPinnedRequired, workflowPermissions: record(workflowPermissions.value), workflows: workflows.files, leastPrivilegeDeclared: workflows.leastPrivilegeDeclared, unpinnedUses: workflows.unpinnedUses },
    environments: array(record(environmentsResult.value).environments).map(record).sort((left, right) => String(left.name).localeCompare(String(right.name))),
    project,
    ...(organization ? { organization } : {}),
    capabilityLimits: ["Audit is read-only and does not change GitHub settings", "Unavailable token scopes are blockers for an explicitly requested scope", "GitHub Team and Enterprise-only settings are reported only when observable"],
    blockers: sorted(blockers), warnings: sorted(warnings), unavailable: sorted(unavailable), status: (blockers.length || unavailable.length ? "blocked" : "pass") as "pass" | "blocked", observedHash: "",
  };
  return { ...report, observedHash: hashObject({ ...report, observedHash: undefined }) };
}
