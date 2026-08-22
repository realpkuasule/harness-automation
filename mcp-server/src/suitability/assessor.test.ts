import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessSuitability } from "./assessor.js";

const roots: string[] = [];

function fixture(commits: number, files: number, tests = 0, dependency = false): string {
  const root = mkdtempSync(join(tmpdir(), "harness-suitability-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: root });
  for (let index = 1; index < commits; index++) execFileSync("git", ["commit", "--allow-empty", "-m", `test: ${index}`], { cwd: root });
  for (let index = 0; index < files; index++) writeFileSync(join(root, `file-${index}.txt`), "fixture\n");
  if (dependency) writeFileSync(join(root, "package.json"), "{}\n");
  if (tests > 0) {
    const directory = join(root, "tests");
    mkdirSync(directory);
    for (let index = 0; index < tests; index++) writeFileSync(join(directory, `test-${index}.txt`), "fixture\n");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("assessSuitability", () => {
  it("scores the documented Git history, file, dependency, and test thresholds", () => {
    expect(assessSuitability({ projectDir: fixture(1, 0) }).score).toBe(20);
    expect(assessSuitability({ projectDir: fixture(4, 6, 1, true) }).score).toBe(55);
    expect(assessSuitability({ projectDir: fixture(11, 21, 11, true) }).score).toBe(80);
    expect(assessSuitability({ projectDir: fixture(51, 101, 0, true) }).score).toBe(80);
  }, 20_000);

  it("keeps quick assessment deliberately independent of dependency and test discovery", () => {
    const projectDir = fixture(1, 0);
    const report = assessSuitability({ projectDir, analysisDepth: "quick" });

    expect(report.score).toBe(20);
    expect(report.warnings.map((warning) => warning.type)).toEqual(["prototype", "prototype"]);
  });

  it("fails safely for missing paths and recognizes every supported dependency manifest", () => {
    const projectDir = fixture(1, 0);
    for (const name of ["requirements.txt", "go.mod", "Cargo.toml", "pom.xml"]) writeFileSync(join(projectDir, name), "fixture\n");
    symlinkSync(join(projectDir, "missing"), join(projectDir, "broken-test-link"));
    expect(assessSuitability({ projectDir }).recommendations).toContain("已检测到依赖管理文件，Harness 可集成到现有工具链");

    const missing = assessSuitability({ projectDir: join(projectDir, "missing") });
    expect(missing.score).toBe(10);
    expect(missing.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "prototype", message: "项目不是 Git 仓库，Harness 依赖 Git 进行版本控制" }),
      expect.objectContaining({ type: "overhead" }),
    ]));
  });

  it("bounds recursive scans while retaining accessible nested test evidence", () => {
    const projectDir = fixture(1, 0);
    const tests = join(projectDir, "tests");
    mkdirSync(join(tests, "nested"), { recursive: true });
    writeFileSync(join(tests, "a.txt"), "fixture\n");
    writeFileSync(join(tests, "b.txt"), "fixture\n");
    writeFileSync(join(tests, ".hidden"), "fixture\n");
    writeFileSync(join(tests, "nested", "test.txt"), "fixture\n");
    symlinkSync(join(tests, "missing"), join(tests, "broken-link"));

    expect(assessSuitability({ projectDir })).toMatchObject({ suitable: true, recommendations: [
      "已检测到测试文件，Harness 可帮助建立持续的测试执行机制",
    ] });
  });
});
