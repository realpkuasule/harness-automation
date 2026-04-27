import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ============================================================
// Dependency Management
// ============================================================

export interface DepCheckResult {
  /** Dependencies that are missing */
  missing: string[];
  /** Whether package.json exists */
  hasPackageJson: boolean;
  /** Whether node_modules exists */
  hasNodeModules: boolean;
  /** Detected package manager */
  packageManager: "npm" | "yarn" | "pnpm" | "unknown";
  /** Suggested install command */
  installCommand: string;
  /** Detected outdated packages (empty if check not run) */
  outdated: Array<{ name: string; current: string; wanted: string }>;
}

/**
 * Check the dependency health of a project.
 */
export function checkDependencies(projectDir: string): DepCheckResult {
  const hasPackageJson = existsSync(join(projectDir, "package.json"));
  const hasNodeModules = existsSync(join(projectDir, "node_modules"));
  const hasYarnLock = existsSync(join(projectDir, "yarn.lock"));
  const hasPnpmLock = existsSync(join(projectDir, "pnpm-lock.yaml"));

  const packageManager = hasPnpmLock
    ? "pnpm"
    : hasYarnLock
      ? "yarn"
      : hasPackageJson
        ? "npm"
        : "unknown";

  const installCommand =
    packageManager === "pnpm"
      ? "pnpm install"
      : packageManager === "yarn"
        ? "yarn install"
        : "npm install";

  // Check specific developer tooling
  const missing: string[] = [];
  const tooling = [
    { name: "husky", check: "husky" },
    { name: "@commitlint/cli", check: "@commitlint/cli" },
    { name: "eslint", check: "eslint" },
  ];

  for (const tool of tooling) {
    if (
      hasPackageJson &&
      !_isDepInstalled(join(projectDir, "package.json"), tool.check)
    ) {
      missing.push(tool.name);
    }
  }

  // Check outdated packages (only if node_modules exists)
  let outdated: Array<{ name: string; current: string; wanted: string }> = [];
  if (hasNodeModules) {
    try {
      const out = execSync("npm outdated --json 2>/dev/null", {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (out) {
        const parsed = JSON.parse(out) as Record<
          string,
          { current: string; wanted: string }
        >;
        outdated = Object.entries(parsed)
          .slice(0, 10)
          .map(([name, info]) => ({
            name,
            current: info.current,
            wanted: info.wanted,
          }));
      }
    } catch {
      // npm outdated exits with non-zero when outdated packages exist
      try {
        const out = execSync("npm outdated --json 2>/dev/null || true", {
          cwd: projectDir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (out && out !== "") {
          const parsed = JSON.parse(out) as Record<
            string,
            { current: string; wanted: string }
          >;
          outdated = Object.entries(parsed)
            .slice(0, 10)
            .map(([name, info]) => ({
              name,
              current: info.current,
              wanted: info.wanted,
            }));
        }
      } catch {
        // Not an npm project or npm not available
      }
    }
  }

  return {
    missing,
    hasPackageJson,
    hasNodeModules,
    packageManager,
    installCommand,
    outdated,
  };
}

function _isDepInstalled(packageJsonPath: string, depName: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return (
      (pkg.dependencies && depName in pkg.dependencies) ||
      (pkg.devDependencies && depName in pkg.devDependencies)
    );
  } catch {
    return false;
  }
}

/**
 * Suggest install commands for missing harness-related dependencies.
 */
export function suggestInstall(
  depName: string,
  packageManager: string,
): string {
  const installCmd =
    packageManager === "pnpm"
      ? "pnpm add -D"
      : packageManager === "yarn"
        ? "yarn add --dev"
        : "npm install --save-dev";

  return `${installCmd} ${depName}`;
}
