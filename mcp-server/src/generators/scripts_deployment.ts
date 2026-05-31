import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Types
// ============================================================

export interface ScriptsDeploymentConfig {
  /** Whether to include task-board scripts (default: true) */
  includeTaskBoard?: boolean;
  /** Whether to include changelog scripts (default: true) */
  includeChangelog?: boolean;
}

export interface ScriptFile {
  /** Target path relative to project root (e.g., "scripts/task.py") */
  path: string;
  /** File content */
  content: string;
  /** Whether this file should be executable */
  executable: boolean;
}

export interface DataFile {
  /** Target path relative to project root (e.g., "TASK.json") */
  path: string;
  /** File content */
  content: string;
}

export interface ScriptsDeploymentOutput {
  scripts: ScriptFile[];
  dataFiles: DataFile[];
}

// ============================================================
// Script Resolution
// ============================================================

/**
 * Resolve the scripts source directory.
 * In dev (tsx): __dirname = .../src/generators/, scripts at ../../../scripts/
 * In prod (node): __dirname = .../dist/generators/, scripts at ../../scripts/ (copied during build)
 */
function getScriptsDir(): string {
  const candidates = [
    join(__dirname, "..", "..", "scripts"),        // dist layout: dist/generators/ -> dist/scripts/
    join(__dirname, "..", "..", "..", "scripts"),  // src layout: src/generators/ -> repo root/scripts/
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(
    "Cannot locate scripts directory. Ensure task.py and changelog.py are available.",
  );
}

// Cache script content to avoid re-reading
let _scriptCache: Map<string, string> | null = null;

function getScriptContent(filename: string): string {
  if (!_scriptCache) {
    _scriptCache = new Map();
  }
  const cached = _scriptCache.get(filename);
  if (cached !== undefined) return cached;

  const scriptsDir = getScriptsDir();
  const filePath = join(scriptsDir, filename);
  if (!existsSync(filePath)) {
    throw new Error(
      `Script file not found: ${filePath}. Ensure ${filename} is available in the scripts directory.`,
    );
  }
  const content = readFileSync(filePath, "utf-8");
  _scriptCache.set(filename, content);
  return content;
}

// ============================================================
// Generator
// ============================================================

/**
 * Generate script and data file deployments for hard constraints
 * (task-board and changelog-convention rules).
 *
 * Returns script files (to be made executable) and data files (TASK.json, CHANGELOG.jsonl)
 * that should be deployed to the target project.
 */
export function generateScriptsDeployment(
  config: ScriptsDeploymentConfig = {},
): ScriptsDeploymentOutput {
  const scripts: ScriptFile[] = [];
  const dataFiles: DataFile[] = [];

  const includeTask = config.includeTaskBoard !== false;
  const includeCl = config.includeChangelog !== false;

  if (includeTask) {
    scripts.push({
      path: "scripts/task.py",
      content: getScriptContent("task.py"),
      executable: true,
    });

    dataFiles.push({
      path: "TASK.json",
      content: JSON.stringify({ tasks: [] }, null, 2) + "\n",
    });
  }

  if (includeCl) {
    scripts.push({
      path: "scripts/changelog.py",
      content: getScriptContent("changelog.py"),
      executable: true,
    });

    dataFiles.push({
      path: "CHANGELOG.jsonl",
      content: "",
    });
  }

  return { scripts, dataFiles };
}
