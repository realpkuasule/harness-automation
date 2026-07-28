import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { hasBuiltInStackAdapter, type AgentDiscovery, type Discovery, type Evidence, type Stack, type StackProfile } from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".harness",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

function walk(root: string, maxDepth = 5): string[] {
  const output: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  };
  visit(root, 0);
  return output.sort();
}

function hasDependency(packageFiles: string[], root: string, name: string): boolean {
  return packageFiles.some((path) => {
    try {
      const parsed = JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
      const sections = ["dependencies", "devDependencies", "peerDependencies"];
      return sections.some((section) => {
        const dependencies = parsed[section] as Record<string, unknown> | undefined;
        return Boolean(dependencies && name in dependencies);
      });
    } catch {
      return false;
    }
  });
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function commandFromProject(packageFiles: string[], files: string[], root: string): Record<string, string[]> {
  const commands: Record<string, string[]> = {};
  const manager = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm"
    : existsSync(join(root, "yarn.lock")) ? "yarn"
    : existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) ? "bun"
    : "npm";
  for (const path of packageFiles) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, path), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const directory = dirname(path) === "." ? "." : dirname(path).replaceAll("\\", "/");
      for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
        const argv = manager === "npm"
          ? ["npm", ...(directory === "." ? [] : ["--prefix", directory]), "run", name]
          : manager === "pnpm"
            ? ["pnpm", ...(directory === "." ? [] : ["--dir", directory]), "run", name]
            : [manager, ...(directory === "." ? [] : ["--cwd", directory]), "run", name];
        commands[`${manager}:${directory}:${name}`] = argv;
        if (command.includes("prisma")) commands[`prisma:${directory}:${name}`] = argv;
      }
    } catch {
      // Invalid manifests are reported by normal project tooling; discovery remains read-only.
    }
  }
  if (existsSync(join(root, "manage.py"))) {
    commands["django:check"] = ["python3", "manage.py", "check"];
    commands["django:test"] = ["python3", "manage.py", "test"];
  }
  if (existsSync(join(root, "go.mod"))) {
    commands["go:test"] = ["go", "test", "./..."];
    commands["go:vet"] = ["go", "vet", "./..."];
  }
  const dotnetTarget = files.find((path) => path.endsWith(".sln")) ??
    files.find((path) => path.endsWith(".csproj"));
  if (dotnetTarget) {
    commands["dotnet:build"] = ["dotnet", "build", dotnetTarget, "--no-restore"];
    commands["dotnet:test"] = ["dotnet", "test", dotnetTarget, "--no-build", "--no-restore"];
  }
  return commands;
}

export function discoverProject(root: string, now = new Date()): Discovery {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Project directory does not exist: ${root}`);
  }

  const files = walk(root);
  const packageFiles = files.filter((path) => basename(path) === "package.json");
  const hasTs = files.some((path) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/u.test(path)) ||
    hasDependency(packageFiles, root, "typescript");
  const hasNest = hasDependency(packageFiles, root, "@nestjs/core");
  const hasNext = hasDependency(packageFiles, root, "next");
  const hasTrpc = hasDependency(packageFiles, root, "@trpc/server");
  const hasPrisma = hasDependency(packageFiles, root, "@prisma/client") ||
    files.some((path) => path.endsWith("schema.prisma"));
  const hasPython = files.some((path) => /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|manage\.py)$/u.test(path));
  const hasDjango = existsSync(join(root, "manage.py")) || files.some((path) => {
    if (!path.endsWith(".txt") && !path.endsWith(".toml")) return false;
    try { return /\bdjango\b/iu.test(readFileSync(join(root, path), "utf8")); } catch { return false; }
  });
  const hasGo = files.includes("go.mod");
  const hasGrpc = files.some((path) => path.endsWith(".proto")) || files.includes("buf.yaml");
  const hasPostgres = hasDependency(packageFiles, root, "pg") || hasPrisma || files.some((path) => {
    if (!/(\.env\.example|compose[^/]*\.ya?ml|pyproject\.toml|requirements[^/]*\.txt)$/u.test(path)) return false;
    try { return /postgres(?:ql)?/iu.test(readFileSync(join(root, path), "utf8")); } catch { return false; }
  });
  const hasK8s = files.some((path) => /(^|\/)(Chart\.yaml|kustomization\.ya?ml)$/u.test(path)) ||
    files.some((path) => /^k8s\//u.test(path) && /\.ya?ml$/u.test(path));
  const hasCSharp = files.some((path) => /\.(?:csproj|sln)$/u.test(path)) ||
    files.some((path) => /(^|\/)Directory\.Build\.(?:props|targets)$/u.test(path));
  const hasGodot = files.some((path) => /(^|\/)project\.godot$/u.test(path));
  const hasUnity = files.some((path) => /(^|\/)ProjectSettings\/ProjectVersion\.txt$/u.test(path));
  const hasRust = files.some((path) => /(^|\/)Cargo\.toml$/u.test(path));
  const hasJava = files.some((path) => /(^|\/)(pom\.xml|build\.gradle)$/u.test(path));
  const hasKotlin = files.some((path) => /(^|\/)build\.gradle\.kts$/u.test(path)) ||
    files.some((path) => path.endsWith(".kt"));
  const hasSwift = files.some((path) => /(^|\/)Package\.swift$/u.test(path)) ||
    files.some((path) => path.endsWith(".xcodeproj/project.pbxproj"));

  const stacks: Stack[] = [];
  if (hasTs) stacks.push("typescript");
  if (hasPython) stacks.push("python");
  if (hasGo) stacks.push("go");
  if (hasPostgres) stacks.push("postgresql");
  if (hasGrpc) stacks.push("grpc");
  if (hasK8s) stacks.push("kubernetes");
  if (hasCSharp) stacks.push("csharp");
  if (hasGodot) stacks.push("godot");
  if (hasUnity) stacks.push("unity");
  if (hasRust) stacks.push("rust");
  if (hasJava) stacks.push("java");
  if (hasKotlin) stacks.push("kotlin");
  if (hasSwift) stacks.push("swift");

  let profile: StackProfile = "custom";
  if (hasNest && hasPrisma && hasTrpc && hasNext) profile = "full-typescript";
  else if (hasPython && hasDjango && hasTs) profile = "python-data-ai";
  else if (hasGo && hasTs && (hasGrpc || files.some((path) => /(^|\/)(sqlc\.ya?ml|ent\/)/u.test(path)))) {
    profile = "go-performance";
  }

  const manifests = files.filter((path) =>
    /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|Package\.swift|project\.godot|ProjectSettings\/ProjectVersion\.txt|Directory\.Build\.(?:props|targets)|[^/]+\.(?:csproj|sln))$/u.test(path),
  );
  const lockfiles = files.filter((path) =>
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|go\.sum|Cargo\.lock|packages\.lock\.json|gradle\.lockfile|Package\.resolved)$/u.test(path),
  );
  const boundaries = unique([
    ...(hasPrisma || hasPostgres ? ["database"] : []),
    ...(hasTrpc ? ["api"] : []),
    ...(hasGrpc ? ["rpc"] : []),
    ...(hasK8s ? ["deployment"] : []),
    ...(hasDependency(packageFiles, root, "celery") || files.some((path) => /celery/iu.test(path)) ? ["queue"] : []),
  ]);

  const agents: AgentDiscovery[] = [{
    id: "portable",
    capabilities: ["root-instructions", "scoped-instructions", "structured-output"],
    evidence: ["Portable AGENTS.md adapter is always available"],
  }];
  if (files.includes("CLAUDE.md") || files.some((path) => path.startsWith(".claude/"))) {
    agents.push({
      id: "claude-code",
      capabilities: ["root-instructions", "scoped-instructions", "instruction-imports", "session-hooks", "mcp"],
      evidence: files.filter((path) => path === "CLAUDE.md" || path.startsWith(".claude/")),
    });
  }
  if (files.includes("AGENTS.md") || files.some((path) => path.startsWith(".codex/"))) {
    agents.push({
      id: "codex",
      capabilities: ["root-instructions", "scoped-instructions", "mcp", "structured-output"],
      evidence: files.filter((path) => path === "AGENTS.md" || path.startsWith(".codex/")),
    });
  }

  const evidence: Evidence[] = [
    { fact: `Detected stack profile: ${profile}`, paths: manifests, confidence: profile === "custom" ? 0.5 : 0.95 },
    { fact: `Detected stacks: ${stacks.join(", ") || "none"}`, paths: manifests, confidence: 0.9 },
  ];
  const warnings: string[] = [];
  if (profile === "custom") warnings.push("No preset stack profile matched exactly; owner-approved custom stacks are required.");
  const stacksWithoutAdapters = stacks.filter((stack) => !hasBuiltInStackAdapter(stack));
  if (stacksWithoutAdapters.length > 0) {
    warnings.push(
      `No built-in stack adapter for: ${stacksWithoutAdapters.join(", ")}. Generic continuity policies remain available; stack-specific enforcement will be reported as blocked.`,
    );
  }
  if (lockfiles.length === 0) warnings.push("No dependency lockfile was found.");

  return {
    schemaVersion: "2.0",
    generatedAt: now.toISOString(),
    profile,
    stacks,
    manifests,
    lockfiles,
    packages: packageFiles.map((path) => path.replace(/\/package\.json$/u, "") || "."),
    commands: commandFromProject(packageFiles, files, root),
    boundaries,
    agents,
    evidence,
    warnings,
  };
}
