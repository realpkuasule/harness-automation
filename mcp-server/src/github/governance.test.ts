import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditGitHubGovernance } from "./governance.js";

const roots: string[] = [];
const originalPath = process.env.PATH;

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harness-github-audit-"));
  roots.push(value);
  execFileSync("git", ["init", "-b", "main"], { cwd: value });
  execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: value });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: value });
  writeFileSync(join(value, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: value });
  execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: value });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/repository.git"], { cwd: value });
  return value;
}

function installGh(directory: string): void {
  const script = `
const endpoint = process.argv.at(-1) || "";
const mode = process.env.HARNESS_GITHUB_AUDIT_MODE;
const fail = mode === "forbidden";
if (fail && endpoint.includes("orgs/example-org/repos")) {
  process.stderr.write("HTTP 403: Resource not accessible by integration");
  process.exit(1);
}
if (mode === "repository-unavailable" && endpoint === "repos/example/repository") {
  process.stderr.write("HTTP 403: token=secret");
  process.exit(1);
}
if (mode === "ruleset-unavailable" && endpoint === "repos/example/repository/rulesets/8") {
  process.stderr.write("HTTP 500: ruleset unavailable");
  process.exit(1);
}
if (mode === "rulesets-unavailable" && endpoint === "repos/example/repository/rulesets?per_page=100") {
  process.stderr.write("HTTP 500: rulesets unavailable");
  process.exit(1);
}
if (mode === "branch-unavailable" && endpoint === "repos/example/repository/branches/main/protection") {
  process.stderr.write("HTTP 500: branch protection unavailable");
  process.exit(1);
}
if (mode === "project-unavailable" && process.argv.includes("project")) {
  process.stderr.write("HTTP 403: project unavailable");
  process.exit(1);
}
if (mode === "organization-edge" && endpoint === "orgs/example-org/rulesets?per_page=100") {
  process.stderr.write("HTTP 500: organization rulesets unavailable");
  process.exit(1);
}
if (mode === "organization-ruleset-detail-unavailable" && endpoint === "orgs/example-org/rulesets/4") {
  process.stderr.write("HTTP 500: organization ruleset unavailable");
  process.exit(1);
}
if (mode === "api-unavailable" && /check-runs|actions\\/permissions|environments/u.test(endpoint)) {
  process.stderr.write("HTTP 500: endpoint unavailable");
  process.exit(1);
}
const responses = {
  "repos/example/repository": { id: 12, full_name: "example/repository", private: false, visibility: "public", default_branch: "main", owner: { login: "example", type: "User" } },
  "repos/example/repository/rulesets?per_page=100": [[{ id: 8, name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } }]],
  "repos/example/repository/rulesets/8": { id: 8, name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 0 } }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build-and-test" }] } }, { type: "non_fast_forward" }, { type: "deletion" }] },
  "repos/example/repository/branches/main/protection": { required_status_checks: { contexts: ["build-and-test"] }, required_pull_request_reviews: { required_approving_review_count: 0 }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } },
  "repos/example/repository/actions/permissions": { enabled: true, allowed_actions: "selected", sha_pinning_required: true },
  "repos/example/repository/actions/permissions/workflow": { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
  "repos/example/repository/environments?per_page=100": [{ total_count: 0, environments: [] }],
  "repos/example/repository/commits/main/check-runs?per_page=100": [{ total_count: 1, check_runs: [{ name: "build-and-test", conclusion: "success" }] }],
  "orgs/example-org/repos?per_page=100": [[{ id: 22, full_name: "example-org/alpha", private: true, visibility: "private", default_branch: "main", owner: { login: "example-org", type: "Organization" } }]],
  "orgs/example-org/rulesets?per_page=100": [[{ id: 4, name: "organization-main", target: "branch", enforcement: "active" }]],
  "orgs/example-org/rulesets/4": { id: 4, name: "organization-main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [] }
};
if (mode === "drift") {
  responses["repos/example/repository/rulesets?per_page=100"] = [[]];
  responses["repos/example/repository/branches/main/protection"] = undefined;
  responses["repos/example/repository/commits/main/check-runs?per_page=100"] = [{ total_count: 0, check_runs: [] }];
  responses["repos/example/repository/actions/permissions"] = { enabled: true, allowed_actions: "all", sha_pinned_required: false };
}
if (mode === "organization-success") {
  responses["orgs/example-org/repos?per_page=100"] = [
    [{ id: 22, full_name: "example-org/alpha", private: true, visibility: "private", default_branch: "main", owner: { login: "example-org", type: "Organization" } }],
    [{ id: 23, full_name: "example-org/omega", private: false, visibility: "public", default_branch: "trunk", owner: { login: "example-org", type: "Organization" } }]
  ];
  responses["repos/example-org/alpha/rulesets?per_page=100"] = [[{ id: 5, name: "alpha-main", target: "branch", enforcement: "active" }]];
  responses["repos/example-org/alpha/rulesets/5"] = { id: 5, name: "alpha-main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [] };
  responses["repos/example-org/alpha/branches/main/protection"] = { required_status_checks: null };
  responses["repos/example-org/omega/rulesets?per_page=100"] = [[], []];
  responses["repos/example-org/omega/branches/trunk/protection"] = { required_status_checks: null };
}
if (mode === "organization-pagination-invalid") responses["orgs/example-org/repos?per_page=100"] = [{}];
if (mode === "pagination-count-mismatch") responses["repos/example/repository/commits/main/check-runs?per_page=100"] = [{ total_count: 2, check_runs: [{ name: "build-and-test", conclusion: "success" }] }];
if (mode === "complete-ruleset") {
  responses["repos/example/repository/branches/main/protection"] = undefined;
  responses["repos/example/repository/rulesets/8"] = { id: 8, name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["main"], exclude: [] } }, rules: [{ type: "pull_request" }, { type: "non_fast_forward" }, { type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build-and-test" }] } }] };
}
if (mode === "excluded-default") {
  responses["repos/example/repository/branches/main/protection"] = undefined;
  responses["repos/example/repository/rulesets/8"] = { id: 8, name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["~DEFAULT_BRANCH"] } }, rules: [{ type: "pull_request" }, { type: "non_fast_forward" }, { type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build-and-test" }] } }] };
}
if (mode === "empty-include") {
  responses["repos/example/repository/branches/main/protection"] = undefined;
  responses["repos/example/repository/rulesets/8"] = { id: 8, name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: [], exclude: [] } }, rules: [{ type: "pull_request" }, { type: "non_fast_forward" }, { type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build-and-test" }] } }] };
}
if (mode === "invalid-required-check") {
  responses["repos/example/repository/rulesets/8"] = { id: 8, name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{}] } }] };
}
if (mode === "invalid-ruleset-conditions") {
  responses["repos/example/repository/rulesets/8"] = { id: 8, name: "main", target: "branch", enforcement: "active", rules: [{ type: "pull_request" }, { type: "non_fast_forward" }, { type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build-and-test" }] } }] };
}
if (mode === "organization-ruleset-invalid") {
  responses["orgs/example-org/rulesets?per_page=100"] = [[{}]];
  responses["repos/example-org/alpha/rulesets?per_page=100"] = [[{}]];
  responses["repos/example-org/alpha/branches/main/protection"] = { required_status_checks: null };
}
if (mode === "visibility-fallback") responses["repos/example/repository"] = { id: 12, private: false, default_branch: "main", owner: {} };
if (mode === "edge") {
  responses["repos/example/repository"] = { id: 12, private: true, owner: {} };
  responses["repos/example/repository/rulesets?per_page=100"] = [[
    { id: "not-a-number" },
    { id: 9, name: "inactive", target: "branch", enforcement: "disabled" },
    { id: 10, name: "tag", target: "tag", enforcement: "active" },
    { id: 11, name: "other", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["other"] } } },
    { id: 12, name: "default", target: "branch", enforcement: "active", conditions: { ref_name: { include: [] } } }
  ]];
  responses["repos/example/repository/rulesets/9"] = { id: 9, name: "inactive", target: "branch", enforcement: "disabled", conditions: { ref_name: { include: ["other"], exclude: [] } }, rules: [] };
  responses["repos/example/repository/rulesets/10"] = { id: 10, name: "tag", target: "tag", enforcement: "active", rules: [] };
  responses["repos/example/repository/rulesets/11"] = { id: 11, name: "other", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["other"], exclude: [] } }, rules: [] };
  responses["repos/example/repository/rulesets/12"] = { id: 12, name: "default", target: "branch", enforcement: "active", conditions: { ref_name: { include: [], exclude: [] } }, rules: [{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "edge-check" }] } }] };
  responses["repos/example/repository/branches/main/protection"] = { required_status_checks: { contexts: [null, "edge-check"] } };
  responses["repos/example/repository/commits/main/check-runs?per_page=100"] = [{ total_count: 2, check_runs: [{ name: "edge-check", conclusion: "failure" }, {}] }];
  responses["repos/example/repository/environments?per_page=100"] = [{ total_count: 1, environments: [{}] }];
}
if (mode === "organization-edge") responses["orgs/example-org/repos?per_page=100"] = [[
  { id: 23, private: true },
  { id: 24, full_name: "example-org/beta", private: false, owner: {} }
]];
if (process.argv.includes("project")) {
  process.stdout.write(JSON.stringify(mode === "project-partial"
    ? { number: 2, owner: { login: "example" }, title: "Development" }
    : { id: "PVT_2", number: 2, owner: { login: "example", type: "User" }, title: "Development" }));
  process.exit(0);
}
const response = responses[endpoint];
if (response === undefined) { process.stderr.write("HTTP 404: Not Found"); process.exit(1); }
process.stdout.write(JSON.stringify(response));
`;
  if (process.platform === "win32") {
    writeFileSync(join(directory, "gh.js"), script, "utf8");
    writeFileSync(join(directory, "gh.cmd"), "@node \"%~dp0gh.js\" %*\r\n", "utf8");
  } else {
    const path = join(directory, "gh");
    writeFileSync(path, `#!/usr/bin/env node\n${script}`, "utf8");
    chmodSync(path, 0o755);
  }
  process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.HARNESS_GITHUB_AUDIT_MODE;
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GitHub governance audit", () => {
  it("reports a protected user-owned repository deterministically without writing the checkout", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    mkdirSync(join(projectRoot, ".github", "workflows"), { recursive: true });
    writeFileSync(join(projectRoot, ".github", "workflows", "ci.yml"), "permissions: read-all\nsteps:\n  - uses: actions/checkout@0123456789012345678901234567890123456789\n", "utf8");
    writeFileSync(join(projectRoot, ".github", "project-workflow.json"), JSON.stringify({ repo: "example/repository", project: { owner: "example", number: 2 } }), "utf8");
    const before = execFileSync("git", ["status", "--porcelain=v1"], { cwd: projectRoot, encoding: "utf8" });

    const first = auditGitHubGovernance({ projectRoot });
    const second = auditGitHubGovernance({ projectRoot });

    expect(first.status).toBe("pass");
    expect(first.observedHash).toBe(second.observedHash);
    expect(first.repository).toMatchObject({ ownerType: "User", visibility: "public", defaultBranch: "main" });
    expect(first.warnings).toContain("USER_OWNED_REPOSITORY: organization Team controls do not apply");
    expect(first.actions).toMatchObject({ shaPinnedRequired: true, unpinnedUses: [] });
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: projectRoot, encoding: "utf8" })).toBe(before);
  }, 20_000);

  it("fails closed when an explicitly requested organization scope is unavailable", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    process.env.HARNESS_GITHUB_AUDIT_MODE = "forbidden";

    const report = auditGitHubGovernance({ projectRoot, organization: "example-org" });

    expect(report.status).toBe("blocked");
    expect(report.unavailable).toEqual(expect.arrayContaining([
      expect.stringContaining("organization repositories"),
    ]));
  });

  it("blocks an unpinned Action only when the repository requires full SHA pins", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    mkdirSync(join(projectRoot, ".github", "workflows"), { recursive: true });
    writeFileSync(join(projectRoot, ".github", "workflows", "ci.yml"), "permissions: read-all\nsteps:\n  - uses: actions/checkout@v4\n", "utf8");

    const report = auditGitHubGovernance({ projectRoot });

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining(["UNPINNED_ACTION: ci.yml:actions/checkout@v4"]));
  });

  it("fails closed for invalid input and unavailable repository evidence", () => {
    const projectRoot = root();
    expect(() => auditGitHubGovernance({ projectRoot, organization: "-invalid" })).toThrow(/INVALID_ORGANIZATION/);

    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    process.env.HARNESS_GITHUB_AUDIT_MODE = "repository-unavailable";
    const unscoped = auditGitHubGovernance({ projectRoot });
    expect(unscoped.scope).toEqual({ repository: "example/repository" });
    const report = auditGitHubGovernance({ projectRoot, organization: "example-org" });
    expect(report).toMatchObject({ status: "blocked", repository: { available: false } });
    expect(report.scope).toEqual({ repository: "example/repository", organization: "example-org" });
    expect(report.unavailable).toEqual(expect.arrayContaining(["repository: HTTP 403: token=[redacted]"]));
  });

  it("reports deterministic repository drift without treating optional GitHub features as compliant", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    process.env.HARNESS_GITHUB_AUDIT_MODE = "drift";
    mkdirSync(join(projectRoot, ".github", "workflows"), { recursive: true });
    writeFileSync(join(projectRoot, ".github", "workflows", "ci.yml"), "steps:\n  - uses: actions/checkout@v4\n", "utf8");
    writeFileSync(join(projectRoot, ".github", "project-workflow.json"), "{not json", "utf8");

    const report = auditGitHubGovernance({ projectRoot });

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      "DEFAULT_BRANCH_UNPROTECTED: main",
      "PULL_REQUEST_RULE_MISSING: main",
      "REQUIRED_CHECK_RULE_MISSING: main",
    ]));
    expect(report.warnings).toContain("UNPINNED_ACTION_OBSERVED: ci.yml:actions/checkout@v4");
    expect(report.unavailable).toContain("project mapping: invalid .github/project-workflow.json");
  });

  it("observes complete and incomplete organization pagination without writes", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    process.env.HARNESS_GITHUB_AUDIT_MODE = "organization-success";
    const complete = auditGitHubGovernance({ projectRoot, organization: "example-org" });
    expect(complete.organization).toMatchObject({ login: "example-org", available: true, repositories: [
      expect.objectContaining({ name: "example-org/alpha", defaultBranchProtected: true, effectiveRulesets: [expect.objectContaining({ id: 5, rules: [] })] }),
      expect.objectContaining({ name: "example-org/omega", defaultBranchProtected: true }),
    ] });

    process.env.HARNESS_GITHUB_AUDIT_MODE = "organization-pagination-invalid";
    const incomplete = auditGitHubGovernance({ projectRoot, organization: "example-org" });
    expect(incomplete.organization).toMatchObject({ login: "example-org", available: false, repositories: [] });
    expect(incomplete.unavailable).toContain("organization repositories: pagination response was incomplete");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "organization-ruleset-detail-unavailable";
    const unavailableDetail = auditGitHubGovernance({ projectRoot, organization: "example-org" });
    expect(unavailableDetail.organization).toMatchObject({ available: false });
    expect(unavailableDetail.unavailable).toContain("organization ruleset 4: HTTP 500: organization ruleset unavailable");
  });

  it("records unavailable rule details without assuming their rules", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    process.env.HARNESS_GITHUB_AUDIT_MODE = "ruleset-unavailable";

    const report = auditGitHubGovernance({ projectRoot });

    expect(report.unavailable).toEqual(expect.arrayContaining(["ruleset 8: HTTP 500: ruleset unavailable"]));
    expect(report.rulesets).toEqual([expect.objectContaining({ id: 8, rules: [] })]);
  });

  it("covers default-branch fallbacks, ruleset filtering, local configuration, and project drift", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    process.env.HARNESS_GITHUB_AUDIT_MODE = "edge";
    mkdirSync(join(projectRoot, ".github", "workflows"), { recursive: true });
    mkdirSync(join(projectRoot, "docs"));
    writeFileSync(join(projectRoot, ".github", "workflows", "edge.yml"), "steps:\n  - uses: ./local\n  - uses: docker://alpine\n  - uses: owner/action\n", "utf8");
    writeFileSync(join(projectRoot, "docs", "CODEOWNERS"), "# comment\n* @owner\nno-owner\n", "utf8");
    writeFileSync(join(projectRoot, ".github", "project-workflow.json"), JSON.stringify({ repo: "other/repository", project: { owner: "", number: "2" } }), "utf8");

    const report = auditGitHubGovernance({ projectRoot });

    expect(report.repository).toMatchObject({ defaultBranch: "main", visibility: "private" });
    expect(report.unavailable).toContain("repository rulesets item 0: response was incomplete");
    expect(report.checks).toMatchObject({ required: ["edge-check"], latest: expect.arrayContaining([expect.objectContaining({ name: "edge-check", conclusion: "failure" })]) });
    expect(report.codeowners).toMatchObject({ path: "docs/CODEOWNERS", owners: ["@owner"] });
    expect(report.actions).toMatchObject({ leastPrivilegeDeclared: false, unpinnedUses: ["edge.yml:owner/action"] });
    expect(report.project).toMatchObject({ configured: true, mapping: "incomplete" });
    expect(report.blockers).toEqual(expect.arrayContaining(["PROJECT_MAPPING_DRIFT: configured other/repository, observed example/repository"]));
    expect(report.warnings).toContain("REQUIRED_CHECK_NOT_PASSING: edge-check");
    expect(report.unavailable).toEqual(expect.arrayContaining([
      "repository: response was incomplete",
      "latest checks item 1: response was incomplete",
      "environments item 0: response was incomplete",
    ]));
  });

  it("fails closed when optional repository settings, project reads, or organization evidence are unavailable", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    mkdirSync(join(projectRoot, ".github"));
    writeFileSync(join(projectRoot, ".github", "project-workflow.json"), JSON.stringify({ project: { owner: "example", number: 2 } }), "utf8");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "api-unavailable";
    const repository = auditGitHubGovernance({ projectRoot });
    expect(repository.unavailable).toEqual(expect.arrayContaining([
      "latest checks: HTTP 500: endpoint unavailable",
      "Actions settings: HTTP 500: endpoint unavailable",
      "Actions workflow permissions: HTTP 500: endpoint unavailable",
      "environments: HTTP 500: endpoint unavailable",
    ]));

    process.env.HARNESS_GITHUB_AUDIT_MODE = "project-unavailable";
    const project = auditGitHubGovernance({ projectRoot });
    expect(project.project).toMatchObject({ mapping: "unavailable" });

    process.env.HARNESS_GITHUB_AUDIT_MODE = "project-partial";
    const partialProject = auditGitHubGovernance({ projectRoot });
    expect(partialProject.project).toMatchObject({ mapping: "unavailable" });
    expect(partialProject.unavailable).toContain("project mapping: response was incomplete");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "pagination-count-mismatch";
    expect(auditGitHubGovernance({ projectRoot }).unavailable)
      .toContain("latest checks: pagination response was incomplete");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "organization-edge";
    const organization = auditGitHubGovernance({ projectRoot, organization: "example-org" });
    expect(organization.organization).toMatchObject({ available: false, repositories: [] });
    expect(organization.unavailable).toEqual(expect.arrayContaining([
      "organization repositories item 0: response was incomplete",
      "organization repositories item 1: response was incomplete",
    ]));
  });

  it("fails closed on incomplete repository and organization ruleset evidence", () => {
    const projectRoot = root();
    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);

    process.env.HARNESS_GITHUB_AUDIT_MODE = "invalid-ruleset-conditions";
    const repository = auditGitHubGovernance({ projectRoot });
    expect(repository.status).toBe("blocked");
    expect(repository.unavailable).toContain("ruleset 8: branch conditions were incomplete");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "organization-ruleset-invalid";
    const organization = auditGitHubGovernance({ projectRoot, organization: "example-org" });
    expect(organization.organization).toMatchObject({ available: false });
    expect(organization.unavailable).toEqual(expect.arrayContaining([
      "organization rulesets item 0: response was incomplete",
      "organization repository rulesets example-org/alpha item 0: response was incomplete",
    ]));

    process.env.HARNESS_GITHUB_AUDIT_MODE = "invalid-required-check";
    expect(auditGitHubGovernance({ projectRoot }).unavailable)
      .toContain("ruleset 8: required checks were incomplete");
  });

  it("does not assume that failed Git metadata, rulesets, or branch protection are safe", () => {
    const projectRoot = root();
    expect(() => auditGitHubGovernance({ projectRoot: join(projectRoot, "missing") })).toThrow(/git failed/);
    execFileSync("git", ["remote", "remove", "origin"], { cwd: projectRoot });
    expect(() => auditGitHubGovernance({ projectRoot })).toThrow(/git failed/);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/repository.git"], { cwd: projectRoot });
    execFileSync("git", ["remote", "set-url", "origin", "https://gitlab.com/example/repository.git"], { cwd: projectRoot });
    expect(() => auditGitHubGovernance({ projectRoot })).toThrow(/GITHUB_REMOTE_REQUIRED/);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/example/repository.git"], { cwd: projectRoot });

    const bin = mkdtempSync(join(tmpdir(), "harness-github-audit-bin-"));
    roots.push(bin);
    installGh(bin);
    process.env.HARNESS_GITHUB_AUDIT_MODE = "rulesets-unavailable";
    expect(auditGitHubGovernance({ projectRoot }).unavailable).toContain("repository rulesets: HTTP 500: rulesets unavailable");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "branch-unavailable";
    expect(auditGitHubGovernance({ projectRoot }).unavailable).toContain("branch protection: HTTP 500: branch protection unavailable");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "complete-ruleset";
    const complete = auditGitHubGovernance({ projectRoot });
    expect(complete.blockers).not.toContain("DEFAULT_BRANCH_UNPROTECTED: main");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "excluded-default";
    const excluded = auditGitHubGovernance({ projectRoot });
    expect(excluded.blockers).toEqual(expect.arrayContaining([
      "DEFAULT_BRANCH_UNPROTECTED: main",
      "PULL_REQUEST_RULE_MISSING: main",
      "REQUIRED_CHECK_RULE_MISSING: main",
    ]));

    process.env.HARNESS_GITHUB_AUDIT_MODE = "empty-include";
    expect(auditGitHubGovernance({ projectRoot }).blockers)
      .toContain("DEFAULT_BRANCH_UNPROTECTED: main");

    process.env.HARNESS_GITHUB_AUDIT_MODE = "visibility-fallback";
    expect(auditGitHubGovernance({ projectRoot }).repository).toMatchObject({ visibility: "public" });
  });
});
