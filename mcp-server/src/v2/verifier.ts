import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse } from "@typescript-eslint/typescript-estree";

export interface NamingCheck {
  enforced: boolean;
  passing: boolean;
  violations: string[];
  detail: string;
}
const SKIP_DIRECTORIES = new Set([
  ".git", ".harness", ".next", ".turbo", "build", "coverage", "dist", "generated", "node_modules", "vendor",
]);
const CAMEL = /^_?[a-z][A-Za-z0-9]*$/u;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/u;
const UPPER = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

function sourceFiles(root: string, extensions: Set<string>): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) visit(path);
      } else if ([...extensions].some((extension) => entry.name.endsWith(extension))) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

function identifiers(pattern: unknown): Array<{ name: string; line: number }> {
  if (!pattern || typeof pattern !== "object") return [];
  const node = pattern as Record<string, unknown>;
  if (node.type === "Identifier") {
    const loc = node.loc as { start?: { line?: number } } | undefined;
    return [{ name: String(node.name), line: loc?.start?.line ?? 0 }];
  }
  if (node.type === "RestElement") return identifiers(node.argument);
  if (node.type === "AssignmentPattern") return identifiers(node.left);
  if (node.type === "ArrayPattern") return ((node.elements as unknown[]) ?? []).flatMap(identifiers);
  if (node.type === "ObjectPattern") {
    return ((node.properties as unknown[]) ?? []).flatMap((property) => {
      const item = property as Record<string, unknown>;
      return item.type === "Property" ? identifiers(item.value) : identifiers(item.argument);
    });
  }
  return [];
}

function line(node: Record<string, unknown>): number {
  return (node.loc as { start?: { line?: number } } | undefined)?.start?.line ?? 0;
}

export function checkTypeScriptSource(source: string, filename: string): string[] {
  const violations: string[] = [];
  let program: unknown;
  try {
    program = parse(source, { jsx: filename.endsWith(".tsx"), loc: true, range: false });
  } catch (error) {
    return [`${filename}: parse error: ${String(error)}`];
  }

  const report = (name: string, at: number, expected: string): void => {
    violations.push(`${filename}:${at}: '${name}' must be ${expected}`);
  };
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    switch (node.type) {
      case "VariableDeclarator": {
        const functionValue = node.init && typeof node.init === "object" &&
          ["ArrowFunctionExpression", "FunctionExpression"].includes(String((node.init as Record<string, unknown>).type));
        for (const identifier of identifiers(node.id)) {
          if (!(CAMEL.test(identifier.name) || UPPER.test(identifier.name) || (functionValue && PASCAL.test(identifier.name)))) {
            report(identifier.name, identifier.line, "camelCase (or PascalCase for a component / UPPER_SNAKE_CASE for a constant)");
          }
        }
        break;
      }
      case "FunctionDeclaration":
      case "FunctionExpression": {
        if (node.id && typeof node.id === "object") {
          const name = String((node.id as Record<string, unknown>).name);
          if (!(CAMEL.test(name) || PASCAL.test(name))) report(name, line(node.id as Record<string, unknown>), "camelCase");
        }
        for (const parameter of (node.params as unknown[] | undefined) ?? []) {
          for (const identifier of identifiers(parameter)) {
            if (!CAMEL.test(identifier.name)) report(identifier.name, identifier.line, "camelCase");
          }
        }
        break;
      }
      case "ArrowFunctionExpression": {
        for (const parameter of (node.params as unknown[] | undefined) ?? []) {
          for (const identifier of identifiers(parameter)) {
            if (!CAMEL.test(identifier.name)) report(identifier.name, identifier.line, "camelCase");
          }
        }
        break;
      }
      case "ClassDeclaration":
      case "ClassExpression":
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
      case "TSEnumDeclaration": {
        if (node.id && typeof node.id === "object") {
          const name = String((node.id as Record<string, unknown>).name);
          if (!PASCAL.test(name)) report(name, line(node.id as Record<string, unknown>), "PascalCase");
        }
        break;
      }
      case "MethodDefinition":
      case "PropertyDefinition": {
        const key = node.key as Record<string, unknown> | undefined;
        if (!node.computed && key?.type === "Identifier") {
          const name = String(key.name);
          if (!(CAMEL.test(name) || name === "constructor")) report(name, line(key), "camelCase");
        }
        break;
      }
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier": {
        const local = node.local as Record<string, unknown> | undefined;
        if (local?.type === "Identifier") {
          const name = String(local.name);
          if (!(CAMEL.test(name) || PASCAL.test(name))) report(name, line(local), "camelCase or PascalCase");
        }
        break;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "range", "parent", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(program);
  return violations;
}

export function checkTypeScript(root: string): NamingCheck {
  const fixture = checkTypeScriptSource("const user_id = 1;", "invalid-fixture.ts");
  const enforced = fixture.some((message) => message.includes("user_id"));
  const violations = sourceFiles(root, new Set([".ts", ".tsx"]))
    .filter((path) => !path.endsWith(".d.ts"))
    .flatMap((path) => checkTypeScriptSource(readFileSync(path, "utf8"), relative(root, path)));
  return {
    enforced,
    passing: violations.length === 0,
    violations,
    detail: `${violations.length} TypeScript naming violation(s)`,
  };
}

function externalChecker(
  command: string,
  args: string[],
  selfTestArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): NamingCheck {
  const fixture = spawnSync(command, selfTestArgs, { encoding: "utf8", env, timeout: 30_000 });
  const enforced = fixture.status === 1;
  if (fixture.error && (fixture.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { enforced: false, passing: false, violations: [], detail: `${command} is not installed` };
  }
  const result = spawnSync(command, args, { encoding: "utf8", env, timeout: 120_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    enforced,
    passing: result.status === 0,
    violations: output.length > 0 ? output.split("\n") : [],
    detail: result.error ? String(result.error) : `${command} exited with ${result.status ?? "no status"}`,
  };
}

export function checkPython(root: string): NamingCheck {
  const checker = join(root, ".harness/generated/check_python_naming.py");
  if (!existsSync(checker)) {
    return { enforced: false, passing: false, violations: [], detail: "Python naming checker is not configured" };
  }
  return externalChecker("python3", [checker, root], [checker, "--self-test"]);
}

export function checkGo(root: string): NamingCheck {
  const checker = join(root, ".harness/generated/check_go_naming.go");
  if (!existsSync(checker)) {
    return { enforced: false, passing: false, violations: [], detail: "Go naming checker is not configured" };
  }
  const env = {
    ...process.env,
    GOCACHE: process.env.GOCACHE || join(tmpdir(), "harness-automation-go-build"),
  };
  return externalChecker("go", ["run", checker, root], ["run", checker, "--self-test"], env);
}
