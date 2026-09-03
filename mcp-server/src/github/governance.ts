import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGitCommand } from "../repository/git.js";
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

function git(cwd: string, args: string[]): string {
  const result = runGitCommand(cwd, args, process.env);
  if (result.error || result.status !== 0) throw new Error(`git failed: ${(result.stderr || result.stdout || result.error || "unknown error").trim()}`);
  return result.stdout.trim();
}

function githubRepository(projectRoot: string): { owner: string; name: string; slug: string; head: string } {
  const remote = git(projectRoot, ["remote", "get-url", "origin"]);
  const matched = remote.match(/github\.com(?::|\/)([^/:\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (!matched) throw new Error(`GITHUB_REMOTE_REQUIRED: origin is not a github.com repository: ${remote}`);
  const owner = matched[1];
  const name = matched[2].replace(/\.git$/u, "");
  if (!owner || !name) throw new Error(`GITHUB_REMOTE_REQUIRED: origin is not a repository: ${remote}`);
  return { owner, name, slug: `${owner}/${name}`, head: git(projectRoot, ["rev-parse", "HEAD"]) };
}

function isNotFound(error: string | undefined): boolean {
  return /\b404\b|not found/iu.test(error ?? "");
}

function sanitized(error: string | undefined): string {
  return (error ?? "unknown error").replace(/(token|authorization)\s*[:=]\s*\S+/giu, "$1=[redacted]").slice(0, 300);
}

function paginatedArray(root: string, endpoint: string, label: string, unavailable: string[]): unknown[] {
  const result = commandJson(root, "gh", [
    "api", "--method", "GET", "--paginate", "--slurp", endpoint,
  ]);
  if (!result.ok) {
    unavailable.push(`${label}: ${sanitized(result.error)}`);
    return [];
  }
  if (!Array.isArray(result.value) || result.value.length === 0 || !result.value.every(Array.isArray)) {
    unavailable.push(`${label}: pagination response was incomplete`);
    return [];
  }
  return result.value.flatMap((page) => page);
}

function paginatedObjectArray(
  root: string,
  endpoint: string,
  key: string,
  label: string,
  unavailable: string[],
): unknown[] {
  const result = commandJson(root, "gh", [
    "api", "--method", "GET", "--paginate", "--slurp", endpoint,
  ]);
  if (!result.ok) {
    unavailable.push(`${label}: ${sanitized(result.error)}`);
    return [];
  }
  if (!Array.isArray(result.value) || result.value.length === 0) {
    unavailable.push(`${label}: pagination response was incomplete`);
    return [];
  }
  const pages = result.value.map(record);
  const totals = pages.map((page) => page.total_count);
  const values = pages.flatMap((page) => array(page[key]));
  if (pages.some((page) => !Array.isArray(page[key])) ||
      totals.some((total) => !Number.isSafeInteger(total) || Number(total) < 0) ||
      totals.some((total) => total !== totals[0]) || values.length !== totals[0]) {
    unavailable.push(`${label}: pagination response was incomplete`);
    return [];
  }
  return values;
}

function rulesetSummaries(values: unknown[], label: string, unavailable: string[]): Json[] {
  return values.map(record).map((item, index) => {
    if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || typeof item.name !== "string" ||
        typeof item.target !== "string" || typeof item.enforcement !== "string") {
      unavailable.push(`${label} item ${index}: response was incomplete`);
    }
    return item;
  });
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

function ruleDetails(root: string, endpoint: string, label: string, list: unknown[], unavailable: string[]): Json[] {
  return array(list).map((item) => record(item)).map((item, index) => {
    const id = item.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      unavailable.push(`${label} list item ${index}: identity was incomplete`);
      return { ...item, rules: [] };
    }
    const result = commandJson(root, "gh", ["api", "--method", "GET", `${endpoint}/${id}`]);
    if (!result.ok) {
      unavailable.push(`${label} ${id}: ${sanitized(result.error)}`);
      return { ...item, rules: [] };
    }
    const detail = record(result.value);
    if (detail.id !== id || typeof detail.name !== "string" || typeof detail.target !== "string" ||
        typeof detail.enforcement !== "string" || !Array.isArray(detail.rules)) {
      unavailable.push(`${label} ${id}: response was incomplete`);
      return { ...item, rules: [] };
    }
    if (detail.target === "branch") {
      const refName = record(record(detail.conditions).ref_name);
      const include = refName.include;
      const exclude = refName.exclude;
      if (!Array.isArray(include) || !include.every((value) => typeof value === "string") ||
          !Array.isArray(exclude) || !exclude.every((value) => typeof value === "string")) {
        unavailable.push(`${label} ${id}: branch conditions were incomplete`);
        return { ...item, rules: [] };
      }
      if ([...include, ...exclude].some((value) => /[*?[\]]/u.test(value))) {
        unavailable.push(`${label} ${id}: branch conditions use unsupported patterns`);
        return { ...item, rules: [] };
      }
    }
    for (const [ruleIndex, ruleValue] of detail.rules.entries()) {
      const rule = record(ruleValue);
      if (typeof rule.type !== "string") {
        unavailable.push(`${label} ${id}: rule ${ruleIndex} was incomplete`);
        return { ...item, rules: [] };
      }
      if (rule.type === "required_status_checks") {
        const checks = record(rule.parameters).required_status_checks;
        if (!Array.isArray(checks) || checks.some((check) => !text(record(check).context))) {
          unavailable.push(`${label} ${id}: required checks were incomplete`);
          return { ...item, rules: [] };
        }
      }
    }
    return detail;
  }).sort((left, right) => String(left.name ?? left.id).localeCompare(String(right.name ?? right.id)));
}

function hasRule(rulesets: Json[], type: string): boolean {
  return rulesets.some((ruleset) => text(ruleset.enforcement) === "active" && array(ruleset.rules)
    .some((rule) => text(record(rule).type) === type));
}

function defaultBranchRulesets(rulesets: Json[], defaultBranch: string): Json[] {
  return rulesets.filter((ruleset) => {
    if (text(ruleset.enforcement) !== "active" || text(ruleset.target) !== "branch") return false;
    const refName = record(record(ruleset.conditions).ref_name);
    const rawInclude = refName.include;
    const rawExclude = refName.exclude;
    if (!Array.isArray(rawInclude) || !Array.isArray(rawExclude)) return false;
    const include = rawInclude.filter((value): value is string => typeof value === "string");
    const exclude = rawExclude.filter((value): value is string => typeof value === "string");
    const matches = (value: string) => value === defaultBranch || value === `refs/heads/${defaultBranch}` ||
      value === "~DEFAULT_BRANCH" || value === "~ALL";
    return include.some(matches) && !exclude.some(matches);
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
  if (!owner || !Number.isSafeInteger(number) || Number(number) < 1) {
    unavailable.push("project mapping: configuration was incomplete");
    return { configured: true, mapping: "incomplete", owner, number };
  }
  const result = commandJson(root, "gh", ["project", "view", String(number), "--owner", owner, "--format", "json"]);
  if (!result.ok) {
    unavailable.push(`project mapping: ${sanitized(result.error)}`);
    return { configured: true, mapping: "unavailable", owner, number };
  }
  const observed = record(result.value);
  const observedOwner = record(observed.owner);
  if (!text(observed.id) || observed.number !== number || text(observedOwner.login)?.toLowerCase() !== owner.toLowerCase() ||
      !["User", "Organization"].includes(text(observedOwner.type) ?? "") || !text(observed.title)) {
    unavailable.push("project mapping: response was incomplete");
    return { configured: true, mapping: "unavailable", owner, number };
  }
  return { configured: true, mapping: "available", owner, number, fields: Object.keys(observed).sort() };
}

function organizationObservation(root: string, organization: string, unavailable: string[]): Json {
  const initialUnavailable = unavailable.length;
  const repositoryUnavailable = unavailable.length;
  const repositories = paginatedArray(root, `orgs/${organization}/repos?per_page=100`, "organization repositories", unavailable)
    .map(record);
  repositories.forEach((repository, index) => {
    const owner = record(repository.owner);
    if (!Number.isSafeInteger(repository.id) || !text(repository.full_name) || !text(repository.default_branch) ||
        !text(repository.visibility) || typeof repository.private !== "boolean" ||
        !text(owner.login) || !text(owner.type)) {
      unavailable.push(`organization repositories item ${index}: response was incomplete`);
    }
  });
  if (unavailable.length !== repositoryUnavailable) {
    return { login: organization, available: false, repositories: [] };
  }
  const rulesetUnavailable = unavailable.length;
  const rulesetSummariesObserved = rulesetSummaries(
    paginatedArray(root, `orgs/${organization}/rulesets?per_page=100`, "organization rulesets", unavailable),
    "organization rulesets",
    unavailable,
  );
  const rulesets = ruleDetails(root, `orgs/${organization}/rulesets`, "organization ruleset", rulesetSummariesObserved, unavailable);
  const rulesetsAvailable = unavailable.length === rulesetUnavailable;
  const repos = repositories.map((repository) => {
    const name = text(repository.full_name);
    const defaultBranch = text(repository.default_branch);
    const beforeRulesets = unavailable.length;
    const effectiveRulesetSummaries = name
      ? rulesetSummaries(
          paginatedArray(root, `repos/${name}/rulesets?per_page=100`, `organization repository rulesets ${name}`, unavailable),
          `organization repository rulesets ${name}`,
          unavailable,
        )
      : (unavailable.push("organization repository rulesets unknown: repository name unavailable"), []);
    const effectiveRulesets = name
      ? ruleDetails(root, `repos/${name}/rulesets`, `organization repository ruleset ${name}`, effectiveRulesetSummaries, unavailable)
      : [];
    const rulesetsComplete = unavailable.length === beforeRulesets;
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
      effectiveRulesets: rulesetsComplete ? effectiveRulesets.map(record).sort((left, right) => String(left.name).localeCompare(String(right.name))) : [],
    };
  }).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return { login: organization, available: rulesetsAvailable && unavailable.length === initialUnavailable, repositories: repos, rulesets: rulesets.map(record).sort((left, right) => String(left.name).localeCompare(String(right.name))) };
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
  const repoOwner = record(repo.owner);
  if (!Number.isSafeInteger(repo.id) || text(repo.full_name) !== local.slug || !text(repo.default_branch) ||
      !text(repo.visibility) || typeof repo.private !== "boolean" ||
      !text(repoOwner.login) || !text(repoOwner.type)) {
    unavailable.push("repository: response was incomplete");
  }
  const defaultBranch = text(repo.default_branch) ?? "main";
  const rulesetList = rulesetSummaries(
    paginatedArray(projectRoot, `repos/${local.slug}/rulesets?per_page=100`, "repository rulesets", unavailable),
    "repository rulesets",
    unavailable,
  );
  const rulesets = ruleDetails(projectRoot, `repos/${local.slug}/rulesets`, "ruleset", rulesetList, unavailable);
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
  const latestValues = paginatedObjectArray(
    projectRoot,
    `repos/${local.slug}/commits/${defaultBranch}/check-runs?per_page=100`,
    "check_runs",
    "latest checks",
    unavailable,
  );
  latestValues.forEach((item, index) => {
    const check = record(item);
    if (!text(check.name) || !(check.conclusion === null || typeof check.conclusion === "string")) {
      unavailable.push(`latest checks item ${index}: response was incomplete`);
    }
  });
  const latest = latestValues.map((item) => ({ name: text(record(item).name), conclusion: text(record(item).conclusion) }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
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
  if (actionsResult.ok && (typeof actions.enabled !== "boolean" || !text(actions.allowed_actions) ||
      typeof actions.sha_pinning_required !== "boolean")) {
    unavailable.push("Actions settings: response was incomplete");
  }
  const workflowSettings = record(workflowPermissions.value);
  if (workflowPermissions.ok && (!text(workflowSettings.default_workflow_permissions) ||
      typeof workflowSettings.can_approve_pull_request_reviews !== "boolean")) {
    unavailable.push("Actions workflow permissions: response was incomplete");
  }
  const shaPinnedRequired = bool(actions.sha_pinning_required) === true;
  if (shaPinnedRequired && workflows.unpinnedUses.length > 0) blockers.push(...workflows.unpinnedUses.map((entry) => `UNPINNED_ACTION: ${entry}`));
  else if (workflows.unpinnedUses.length > 0) warnings.push(...workflows.unpinnedUses.map((entry) => `UNPINNED_ACTION_OBSERVED: ${entry}`));
  const environments = paginatedObjectArray(
    projectRoot,
    `repos/${local.slug}/environments?per_page=100`,
    "environments",
    "environments",
    unavailable,
  );
  environments.forEach((item, index) => {
    const environment = record(item);
    if (!Number.isSafeInteger(environment.id) || !text(environment.name)) {
      unavailable.push(`environments item ${index}: response was incomplete`);
    }
  });
  const project = projectObservation(projectRoot, local.slug, unavailable, blockers);
  const owner = repoOwner;
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
    environments: environments.map(record).sort((left, right) => String(left.name).localeCompare(String(right.name))),
    project,
    ...(organization ? { organization } : {}),
    capabilityLimits: ["Audit is read-only and does not change GitHub settings", "Unavailable token scopes are blockers for an explicitly requested scope", "GitHub Team and Enterprise-only settings are reported only when observable"],
    blockers: sorted(blockers), warnings: sorted(warnings), unavailable: sorted(unavailable), status: (blockers.length || unavailable.length ? "blocked" : "pass") as "pass" | "blocked", observedHash: "",
  };
  return { ...report, observedHash: hashObject({ ...report, observedHash: undefined }) };
}
