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
 * In plugin: __dirname = .../plugin/dist/generators/, scripts at ../../scripts/
 */
function getScriptsDir(): string | null {
  const candidates = [
    join(__dirname, "..", "..", "scripts"),        // dist layout: dist/generators/ -> dist/scripts/
    join(__dirname, "..", "..", "..", "scripts"),  // src layout: src/generators/ -> repo root/scripts/
    join(__dirname, "..", "..", "..", "..", "scripts"), // plugin: plugin/dist/generators/ -> plugin/scripts/
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

// Cache script content to avoid re-reading
let _scriptCache: Map<string, string> | null = null;

function getScriptContent(filename: string): string | null {
  if (!_scriptCache) {
    _scriptCache = new Map();
  }
  const cached = _scriptCache.get(filename);
  if (cached !== undefined) return cached;

  const scriptsDir = getScriptsDir();
  if (!scriptsDir) {
    console.error(`[harness] Scripts directory not found — skipping ${filename}. Run "npm run build" to regenerate dist/scripts/.`);
    return null;
  }
  const filePath = join(scriptsDir, filename);
  if (!existsSync(filePath)) {
    console.error(`[harness] Script file not found: ${filePath} — skipping.`);
    return null;
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
    const content = getScriptContent("task.py");
    if (content) {
      scripts.push({
        path: "scripts/task.py",
        content,
        executable: true,
      });
    }

    dataFiles.push({
      path: "TASK.json",
      content: JSON.stringify({ tasks: [] }, null, 2) + "\n",
    });
  }

  if (includeCl) {
    const content = getScriptContent("changelog.py");
    if (content) {
      scripts.push({
        path: "scripts/changelog.py",
        content,
        executable: true,
      });
    }

    dataFiles.push({
      path: "CHANGELOG.jsonl",
      content: "",
    });
  }

  return { scripts, dataFiles };
}
