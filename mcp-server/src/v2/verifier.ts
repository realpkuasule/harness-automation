import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse } from "@typescript-eslint/typescript-estree";
import { TYPESCRIPT_NAMING_RULE_ID, type TypeScriptNamingBaseline } from "./types.js";

export interface NamingCheck {
  adapterReachable: boolean;
  knownBadRejected: boolean;
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
const NODE_SPECIAL_IDENTIFIERS = new Set(["__dirname", "__filename"]);

export interface TypeScriptNamingViolation {
  ruleId: typeof TYPESCRIPT_NAMING_RULE_ID;
  fingerprint: string | null;
  path: string;
  line: number;
  name: string | null;
  kind: string;
  expected: string;
  message: string;
}

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

function zodBindings(program: unknown): Set<string> {
  const bindings = new Set<string>();
  if (!program || typeof program !== "object") return bindings;
  for (const statement of ((program as Record<string, unknown>).body as unknown[] | undefined) ?? []) {
    if (!statement || typeof statement !== "object") continue;
    const declaration = statement as Record<string, unknown>;
    const source = declaration.source as Record<string, unknown> | undefined;
    if (declaration.type !== "ImportDeclaration" || source?.value !== "zod") continue;
    for (const specifier of (declaration.specifiers as unknown[] | undefined) ?? []) {
      if (!specifier || typeof specifier !== "object") continue;
      const item = specifier as Record<string, unknown>;
      const local = item.local as Record<string, unknown> | undefined;
      const imported = item.imported as Record<string, unknown> | undefined;
      if (local?.type !== "Identifier") continue;
      if (item.type !== "ImportSpecifier" || imported?.name === "z") bindings.add(String(local.name));
    }
  }
  return bindings;
}

function moduleVariableDeclarations(program: unknown): {
  constants: WeakSet<object>;
  exports: WeakSet<object>;
} {
  const constants = new WeakSet<object>();
  const exports = new WeakSet<object>();
  if (!program || typeof program !== "object") return { constants, exports };
  for (const statement of ((program as Record<string, unknown>).body as unknown[] | undefined) ?? []) {
    if (!statement || typeof statement !== "object") continue;
    const outer = statement as Record<string, unknown>;
    const exported = outer.type === "ExportNamedDeclaration" || outer.type === "ExportDefaultDeclaration";
    const declaration = exported ? outer.declaration as Record<string, unknown> | undefined : outer;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of (declaration.declarations as unknown[] | undefined) ?? []) {
      if (!item || typeof item !== "object") continue;
      if (declaration.kind === "const") constants.add(item);
      if (exported) exports.add(item);
    }
  }
  return { constants, exports };
}

function expressionRoot(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "CallExpression" || node.type === "NewExpression") return expressionRoot(node.callee);
  if (node.type === "MemberExpression") return expressionRoot(node.object);
  if (["ChainExpression", "TSAsExpression", "TSTypeAssertion", "TSNonNullExpression"].includes(String(node.type))) {
    return expressionRoot(node.expression);
  }
  return null;
}

function isZodSchema(value: unknown, bindings: Set<string>): boolean {
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== "CallExpression") return false;
  const root = expressionRoot((value as Record<string, unknown>).callee);
  return root !== null && bindings.has(root);
}

function jsxComponentNames(program: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "JSXOpeningElement") {
      const name = node.name as Record<string, unknown> | undefined;
      if (name?.type === "JSXIdentifier") names.add(String(name.name));
    }
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "range", "parent", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(program);
  return names;
}

function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function inspectTypeScriptSource(source: string, filename: string): TypeScriptNamingViolation[] {
  const violations: TypeScriptNamingViolation[] = [];
  let program: unknown;
  try {
    program = parse(source, { jsx: filename.endsWith(".tsx"), loc: true, range: false });
  } catch (error) {
    const message = `${filename}: parse error: ${String(error)}`;
    return [{
      ruleId: TYPESCRIPT_NAMING_RULE_ID,
      fingerprint: null,
      path: filename,
      line: 0,
      name: null,
      kind: "parse-error",
      expected: "valid TypeScript",
      message,
    }];
  }

  const bindings = zodBindings(program);
  const moduleVariables = moduleVariableDeclarations(program);
  const jsxComponents = jsxComponentNames(program);
  const report = (name: string, at: number, kind: string, expected: string): void => {
    const identity = [TYPESCRIPT_NAMING_RULE_ID, filename, kind, name];
    const message = `${filename}:${at}: '${name}' must be ${expected}`;
    violations.push({
      ruleId: TYPESCRIPT_NAMING_RULE_ID,
      fingerprint: fingerprint(identity),
      path: filename,
      line: at,
      name,
      kind,
      expected,
      message,
    });
  };
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    switch (node.type) {
      case "VariableDeclarator": {
        const functionValue = node.init && typeof node.init === "object" &&
          ["ArrowFunctionExpression", "FunctionExpression"].includes(String((node.init as Record<string, unknown>).type));
        const schemaValue = moduleVariables.exports.has(node) && isZodSchema(node.init, bindings);
        for (const identifier of identifiers(node.id)) {
          const moduleConstant = moduleVariables.constants.has(node) && UPPER.test(identifier.name);
          const schema = schemaValue && identifier.name.endsWith("Schema") && PASCAL.test(identifier.name);
          if (!(CAMEL.test(identifier.name) || moduleConstant || NODE_SPECIAL_IDENTIFIERS.has(identifier.name) ||
            ((functionValue || jsxComponents.has(identifier.name)) && PASCAL.test(identifier.name)) || schema)) {
            report(identifier.name, identifier.line, "variable", "camelCase (or PascalCase for a component/schema / UPPER_SNAKE_CASE for a module constant)");
          }
        }
        break;
      }
      case "FunctionDeclaration":
      case "FunctionExpression": {
        if (node.id && typeof node.id === "object") {
          const name = String((node.id as Record<string, unknown>).name);
          if (!(CAMEL.test(name) || PASCAL.test(name))) report(name, line(node.id as Record<string, unknown>), "function", "camelCase");
        }
        for (const parameter of (node.params as unknown[] | undefined) ?? []) {
          for (const identifier of identifiers(parameter)) {
            if (!(CAMEL.test(identifier.name) || identifier.name === "_")) report(identifier.name, identifier.line, "parameter", "camelCase");
          }
        }
        break;
      }
      case "ArrowFunctionExpression": {
        for (const parameter of (node.params as unknown[] | undefined) ?? []) {
          for (const identifier of identifiers(parameter)) {
            if (!(CAMEL.test(identifier.name) || identifier.name === "_")) report(identifier.name, identifier.line, "parameter", "camelCase");
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
          if (!PASCAL.test(name)) report(name, line(node.id as Record<string, unknown>), String(node.type), "PascalCase");
        }
        break;
      }
      case "MethodDefinition":
      case "PropertyDefinition": {
        const key = node.key as Record<string, unknown> | undefined;
        if (!node.computed && key?.type === "Identifier") {
          const name = String(key.name);
          const staticReadonlyConstant = node.type === "PropertyDefinition" && node.static === true && node.readonly === true && UPPER.test(name);
          if (!(CAMEL.test(name) || name === "constructor" || staticReadonlyConstant)) report(name, line(key), "member", "camelCase");
        }
        break;
      }
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier": {
        const local = node.local as Record<string, unknown> | undefined;
        if (local?.type === "Identifier") {
          const name = String(local.name);
          if (!(CAMEL.test(name) || PASCAL.test(name) || UPPER.test(name))) report(name, line(local), "import", "camelCase, PascalCase, or UPPER_SNAKE_CASE");
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

export function checkTypeScriptSource(source: string, filename: string): string[] {
  return inspectTypeScriptSource(source, filename).map((violation) => violation.message);
}

export function inspectTypeScript(root: string): TypeScriptNamingViolation[] {
  return sourceFiles(root, new Set([".ts", ".tsx"]))
    .filter((path) => !path.endsWith(".d.ts"))
    .flatMap((path) => inspectTypeScriptSource(readFileSync(path, "utf8"), relative(root, path).replaceAll("\\", "/")));
}

export function checkTypeScript(root: string, approvedBaseline?: TypeScriptNamingBaseline): NamingCheck {
  const fixture = checkTypeScriptSource("const user_id = 1;", "invalid-fixture.ts");
  const enforced = fixture.some((message) => message.includes("user_id"));
  const observed = inspectTypeScript(root);
  const approvedFingerprints = approvedBaseline?.ruleId === TYPESCRIPT_NAMING_RULE_ID &&
    Array.isArray(approvedBaseline.fingerprints)
    ? approvedBaseline.fingerprints
    : null;
  const approved = approvedFingerprints
    ? new Map<string, number>()
    : null;
  for (const item of approvedFingerprints ?? []) {
    if (approved) approved.set(item, (approved.get(item) ?? 0) + 1);
  }
  const violations = approved === null
    ? observed
    : observed.filter((violation) => {
        if (violation.fingerprint === null) return true;
        const remaining = approved.get(violation.fingerprint) ?? 0;
        if (remaining === 0) return true;
        approved.set(violation.fingerprint, remaining - 1);
        return false;
      });
  return {
    adapterReachable: true,
    knownBadRejected: enforced,
    enforced,
    passing: violations.length === 0,
    violations: violations.map((violation) => violation.message),
    detail: approved === null
      ? `${violations.length} TypeScript naming violation(s)`
      : `${violations.length} new TypeScript naming violation(s); ${observed.length - violations.length} approved baseline violation(s) remain`,
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
    return {
      adapterReachable: false,
      knownBadRejected: false,
      enforced: false,
      passing: false,
      violations: [],
      detail: `${command} is not installed`,
    };
  }
  const result = spawnSync(command, args, { encoding: "utf8", env, timeout: 120_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    adapterReachable: fixture.error === undefined,
    knownBadRejected: enforced,
    enforced,
    passing: result.status === 0,
    violations: output.length > 0 ? output.split("\n") : [],
    detail: result.error ? String(result.error) : `${command} exited with ${result.status ?? "no status"}`,
  };
}

export function checkPython(root: string): NamingCheck {
  const checker = join(root, ".harness/generated/check_python_naming.py");
  if (!existsSync(checker)) {
    return {
      adapterReachable: false,
      knownBadRejected: false,
      enforced: false,
      passing: false,
      violations: [],
      detail: "Python naming checker is not configured",
    };
  }
  return externalChecker("python3", [checker, root], [checker, "--self-test"]);
}

export function goCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): string {
  if (env.GOCACHE) return env.GOCACHE;
  const identity = uid === undefined
    ? `user-${(env.USERNAME ?? env.USER ?? "default").replace(/[^A-Za-z0-9_.-]/gu, "_")}`
    : `uid-${uid}`;
  return join(tmpdir(), `harness-automation-go-build-${identity}`);
}

export function checkGo(root: string): NamingCheck {
  const checker = join(root, ".harness/generated/check_go_naming.go");
  if (!existsSync(checker)) {
    return {
      adapterReachable: false,
      knownBadRejected: false,
      enforced: false,
      passing: false,
      violations: [],
      detail: "Go naming checker is not configured",
    };
  }
  const env = {
    ...process.env,
    GOCACHE: goCacheDirectory(),
  };
  return externalChecker("go", ["run", checker, root], ["run", checker, "--self-test"], env);
}
