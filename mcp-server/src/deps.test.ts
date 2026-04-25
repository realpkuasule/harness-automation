import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkDependencies, suggestInstall } from "./deps.js";

describe("checkDependencies — environment detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ht-deps-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. No package.json
  it("detects no package.json in empty directory", () => {
    const result = checkDependencies(tmpDir);
    expect(result.hasPackageJson).toBe(false);
    expect(result.hasNodeModules).toBe(false);
    expect(result.packageManager).toBe("unknown");
  });

  // 2. package.json only, no node_modules
  it("detects package.json without node_modules", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    const result = checkDependencies(tmpDir);
    expect(result.hasPackageJson).toBe(true);
    expect(result.hasNodeModules).toBe(false);
    expect(result.packageManager).toBe("npm");
  });

  // 3. npm project
  it("detects npm project with node_modules", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    mkdirSync(join(tmpDir, "node_modules"));
    const result = checkDependencies(tmpDir);
    expect(result.hasPackageJson).toBe(true);
    expect(result.hasNodeModules).toBe(true);
    expect(result.packageManager).toBe("npm");
  });

  // 4. yarn project
  it("detects yarn project by yarn.lock", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    writeFileSync(join(tmpDir, "yarn.lock"), "", "utf-8");
    const result = checkDependencies(tmpDir);
    expect(result.packageManager).toBe("yarn");
  });

  // 5. pnpm project
  it("detects pnpm project by pnpm-lock.yaml", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "", "utf-8");
    const result = checkDependencies(tmpDir);
    expect(result.packageManager).toBe("pnpm");
  });

  // 6. install commands match
  it("returns correct installCommand for each package manager", () => {
    // npm
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    expect(checkDependencies(tmpDir).installCommand).toBe("npm install");

    // pnpm (yarn.lock also present, but pnpm-lock.yaml takes priority)
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "", "utf-8");
    expect(checkDependencies(tmpDir).installCommand).toBe("pnpm install");

    // yarn only (no pnpm-lock)
    rmSync(join(tmpDir, "pnpm-lock.yaml"));
    writeFileSync(join(tmpDir, "yarn.lock"), "", "utf-8");
    expect(checkDependencies(tmpDir).installCommand).toBe("yarn install");
  });
});

describe("checkDependencies — tool detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ht-deps2-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 7. eslint installed
  it("does not report eslint as missing when in devDependencies", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { eslint: "^8.0.0" } }),
      "utf-8",
    );
    const result = checkDependencies(tmpDir);
    expect(result.missing).not.toContain("eslint");
  });

  // 8. husky missing
  it("reports husky as missing when not in package.json", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    const result = checkDependencies(tmpDir);
    expect(result.missing).toContain("husky");
  });

  // 9. partial install
  it("reports @commitlint/cli as missing when only eslint present", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { eslint: "^8.0.0" } }),
      "utf-8",
    );
    const result = checkDependencies(tmpDir);
    expect(result.missing).toContain("@commitlint/cli");
    expect(result.missing).not.toContain("eslint");
  });
});

describe("checkDependencies — npm outdated", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ht-deps3-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 10. No node_modules
  it("returns empty outdated when no node_modules", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
    const result = checkDependencies(tmpDir);
    expect(result.outdated).toEqual([]);
  });

  // 11. node_modules without package.json
  it("detects node_modules but unknown package manager when no package.json", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    const result = checkDependencies(tmpDir);
    expect(result.hasNodeModules).toBe(true);
    expect(result.packageManager).toBe("unknown");
  });

  // 12. empty dependencies
  it("correctly reports missing tools when dependencies object is empty", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {}, devDependencies: {} }),
      "utf-8",
    );
    const result = checkDependencies(tmpDir);
    expect(result.missing).toContain("husky");
    expect(result.missing).toContain("eslint");
  });
});

describe("suggestInstall", () => {
  // 13-15. Install commands
  it("returns npm install --save-dev for npm", () => {
    expect(suggestInstall("eslint", "npm")).toBe("npm install --save-dev eslint");
  });

  it("returns pnpm add -D for pnpm", () => {
    expect(suggestInstall("eslint", "pnpm")).toBe("pnpm add -D eslint");
  });

  it("returns yarn add --dev for yarn", () => {
    expect(suggestInstall("eslint", "yarn")).toBe("yarn add --dev eslint");
  });
});
