import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "../..");
const tsx = join(packageRoot, "node_modules/.bin/tsx");
const cli = join(packageRoot, "src/cli.ts");
const projects: string[] = [];

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function run(root: string, args: string[]): Record<string, unknown> {
  const result = spawnSync(tsx, [cli, ...args, "--project", root], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});
describe("v2 CLI forward flow", () => {
  it("runs the owner-approved workflow in a fresh process for every step", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cli-v2-"));
    projects.push(root);
    write(root, "docs/PRD.md", "# Service\n");
    write(root, "docs/design/architecture.md", "# Architecture\n");
    write(root, "docs/research/github.md", "# Evidence\n");
    write(root, "package.json", JSON.stringify({ dependencies: {
      "@nestjs/core": "1", "@prisma/client": "1", "@trpc/server": "1", next: "1", typescript: "1",
    } }));
    write(root, "package-lock.json", "{}\n");
    write(root, "tsconfig.json", "{}\n");
    write(root, "prisma/schema.prisma", "datasource db { provider = \"postgresql\" }\n");
    write(root, "src/service.ts", "export const userId = 1;\n");

    expect(run(root, ["doctor"]).prd).toBe(true);
    run(root, ["intake", "--owner", "owner", "--approve-sources"]);
    expect(run(root, ["discover"]).profile).toBe("full-typescript");
    const planned = run(root, ["plan", "--profile", "full-typescript"]);
    const planPath = String(planned.planPath);
    const planHash = String(planned.planHash);
    const applied = run(root, ["apply", "--plan", planPath, "--approve", planHash]);
    expect(applied.planHash).toBe(planHash);
    expect(run(root, ["context", "--agent", "codex"]).agent).toBe("codex");
    const checked = run(root, ["check", "--mode", "session"]);
    expect(checked.ok).toBe(true);
    expect((run(root, ["explain", "typescript-naming"]).id)).toBe("typescript-naming");
    expect(run(root, ["drift"]).clean).toBe(true);
  }, 30_000);
});
