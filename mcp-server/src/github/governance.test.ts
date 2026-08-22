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
const fail = process.env.HARNESS_GITHUB_AUDIT_MODE === "forbidden";
if (fail && endpoint.includes("orgs/example-org/repos")) {
  process.stderr.write("HTTP 403: Resource not accessible by integration");
  process.exit(1);
}
const responses = {
  "repos/example/repository": { id: 12, full_name: "example/repository", private: false, visibility: "public", default_branch: "main", owner: { login: "example", type: "User" } },
  "repos/example/repository/rulesets": [{ id: 8, name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } }],
  "repos/example/repository/rulesets/8": { id: 8, name: "main", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 0 } }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build-and-test" }] } }, { type: "non_fast_forward" }, { type: "deletion" }] },
  "repos/example/repository/branches/main/protection": { required_status_checks: { contexts: ["build-and-test"] }, required_pull_request_reviews: { required_approving_review_count: 0 }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } },
  "repos/example/repository/actions/permissions": { enabled: true, allowed_actions: "selected", sha_pinned_required: true },
  "repos/example/repository/actions/permissions/workflow": { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
  "repos/example/repository/environments": { environments: [] },
  "repos/example/repository/commits/main/check-runs": { check_runs: [{ name: "build-and-test", conclusion: "success" }] },
  "orgs/example-org/repos?per_page=100": [[{ id: 22, full_name: "example-org/alpha", private: true, visibility: "private", default_branch: "main", owner: { login: "example-org", type: "Organization" } }]],
  "orgs/example-org/rulesets": [{ id: 4, name: "organization-main", target: "branch", enforcement: "active" }]
};
if (process.argv.includes("project")) {
  process.stdout.write(JSON.stringify({ number: 2, owner: { login: "example" }, title: "Development" }));
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
  });

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
});
