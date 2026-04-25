import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { SuitabilityAssessment, SuitabilityWarning } from "../types.js";

export interface SuitabilityInput {
  projectDir: string;
  techStack?: string[];
  analysisDepth?: "quick" | "full";
}

/**
 * Assess whether a project is suitable for Harness automation.
 *
 * Checks:
 *  1. Git history depth (commits > 3 → mature enough)
 *  2. File count (> 5 meaningful files)
 *  3. Dependencies (package.json or equivalent)
 *  4. Test file existence
 *  5. Project phase indicators
 *
 * In quick mode, skips dependency and test checks.
 */
export function assessSuitability(input: SuitabilityInput): SuitabilityAssessment {
  const { projectDir, analysisDepth = "full" } = input;
  const warnings: SuitabilityWarning[] = [];
  const recommendations: string[] = [];
  let score = 0;

  // 1. Git history (always checked)
  const gitResult = assessGitHistory(projectDir, warnings);
  score += gitResult;

  // 2. File structure (always checked)
  const fileResult = assessFileStructure(projectDir, warnings, recommendations);
  score += fileResult;

  if (analysisDepth === "full") {
    // 3. Dependencies
    const depResult = assessDependencies(projectDir, warnings, recommendations);
    score += depResult;

    // 4. Test files
    const testResult = assessTestFiles(projectDir, recommendations);
    score += testResult;
  } else {
    // Quick mode: skip dependency and test checks, still add a note
    score += 10; // partial credit
  }

  const suitable = score >= 30;
  const reason = suitable
    ? "项目适合使用 Harness 约束体系"
    : "项目尚不适合 Harness：核心指标不足（得分 " + score + "/100）。参考建议：建立基础 Git 工作流 → 添加测试 → 完善依赖管理";

  return {
    suitable,
    score: Math.min(100, Math.max(0, score)),
    reason,
    warnings,
    recommendations,
  };
}

function assessGitHistory(
  projectDir: string,
  warnings: SuitabilityWarning[],
): number {
  try {
    const output = execSync(
      "git rev-list --count HEAD 2>/dev/null || echo 0",
      { cwd: projectDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const count = parseInt(output.trim(), 10) || 0;

    if (count > 50) {
      return 30;
    }
    if (count > 10) {
      return 20;
    }
    if (count > 3) {
      return 10;
    }

    warnings.push({
      type: "prototype",
      severity: count === 0 ? "high" : "medium",
      message: count === 0
        ? "项目没有 Git 历史，可能处于初始化阶段"
        : `Git 历史较浅（${count} commits），建议积累更多提交后再引入约束`,
      evidence: [`git rev-list --count = ${count}`],
    });
    return 5;
  } catch {
    warnings.push({
      type: "prototype",
      severity: "high",
      message: "项目不是 Git 仓库，Harness 依赖 Git 进行版本控制",
      evidence: ["git rev-list --count 失败 — 不是 Git 仓库"],
    });
    return 0;
  }
}

function assessFileStructure(
  projectDir: string,
  warnings: SuitabilityWarning[],
  recommendations: string[],
): number {
  let fileCount = 0;

  try {
    const entries = readdirSync(projectDir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(projectDir, entry);
      try {
        const s = statSync(full);
        if (s.isDirectory()) {
          fileCount += countFilesRecursive(full, 0);
        } else {
          fileCount++;
        }
      } catch {
        // skip inaccessible
      }
    }
  } catch {
    warnings.push({
      type: "overhead",
      severity: "medium",
      message: "无法扫描项目目录结构",
    });
    return 5;
  }

  if (fileCount > 100) {
    recommendations.push("项目结构成熟，Harness 可有效管理约束");
    return 25;
  }
  if (fileCount > 20) {
    recommendations.push("项目已具备一定规模，建议尽早引入 Harness 约束");
    return 15;
  }
  if (fileCount > 5) {
    return 10;
  }

  warnings.push({
    type: "prototype",
    severity: "medium",
    message: `项目文件较少（${fileCount} 个），Harness 在小项目中的收益有限`,
    evidence: [`扫描到 ${fileCount} 个源文件`],
  });
  return 5;
}

function countFilesRecursive(dir: string, limit: number): number {
  let count = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (count > limit) return count;
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      try {
        const s = statSync(full);
        if (s.isDirectory()) {
          count += countFilesRecursive(full, limit - count);
        } else {
          count++;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip inaccessible
  }
  return count;
}

function assessDependencies(
  projectDir: string,
  warnings: SuitabilityWarning[],
  recommendations: string[],
): number {
  const hasPackageJson = existsSync(join(projectDir, "package.json"));
  const hasRequirements = existsSync(join(projectDir, "requirements.txt"));
  const hasGoMod = existsSync(join(projectDir, "go.mod"));
  const hasCargo = existsSync(join(projectDir, "Cargo.toml"));
  const hasPom = existsSync(join(projectDir, "pom.xml"));

  const found: string[] = [];
  if (hasPackageJson) found.push("package.json");
  if (hasRequirements) found.push("requirements.txt");
  if (hasGoMod) found.push("go.mod");
  if (hasCargo) found.push("Cargo.toml");
  if (hasPom) found.push("pom.xml");

  const depCount = found.length;

  if (depCount > 0) {
    recommendations.push("已检测到依赖管理文件，Harness 可集成到现有工具链");
    return 20;
  }

  warnings.push({
    type: "script",
    severity: "medium",
    message: "未检测到依赖管理文件（package.json/requirements.txt/go.mod），建议先建立依赖管理",
    evidence: [`检查了 package.json/requirements.txt/go.mod/Cargo.toml/pom.xml，均不存在`],
  });
  return 5;
}

function assessTestFiles(
  projectDir: string,
  recommendations: string[],
): number {
  let testCount = 0;

  try {
    const entries = readdirSync(projectDir);
    const testDirs = entries.filter(
      (e) => e.includes("test") || e === "tests" || e === "__tests__",
    );

    for (const dir of testDirs) {
      const full = join(projectDir, dir);
      try {
        if (statSync(full).isDirectory()) {
          testCount += countFilesRecursive(full, 100);
        }
      } catch {
        // skip
      }
    }
  } catch {
    return 0;
  }

  if (testCount > 10) {
    recommendations.push("测试体系完善，Harness 可确保测试在提交/合并前始终执行");
    return 25;
  }
  if (testCount > 0) {
    recommendations.push("已检测到测试文件，Harness 可帮助建立持续的测试执行机制");
    return 15;
  }

  return 5;
}
