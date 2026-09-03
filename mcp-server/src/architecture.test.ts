import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

function program(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(join(sourceRoot, path), "utf8"), ts.ScriptTarget.ES2022, true);
}

function moduleSpecifiers(path: string): string[] {
  return program(path).statements.flatMap((statement) => {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

function callsGit(path: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "spawnSync" && ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "git") {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(program(path));
  return found;
}

function importedBindings(path: string): string[] {
  return program(path).statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)) return [];
    return statement.importClause.namedBindings.elements.map((element) => element.name.text);
  });
}

function exportedFunctionNames(path: string): string[] {
  return program(path).statements.flatMap((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [statement.name.text]
      : []);
}

describe("C-14 bounded domain seams", () => {
  it("keeps delivery and session independent of the legacy worktree facade", () => {
    for (const path of ["delivery/service.ts", "session/service.ts"]) {
      expect(moduleSpecifiers(path)).not.toContain("../worktree/service.js");
    }
    expect(moduleSpecifiers("delivery/service.ts")).toContain("../repository/remote.js");
    expect(moduleSpecifiers("session/service.ts")).toContain("../worktree/config.js");
  });

  it("keeps one Git executor seam and no repository-local state authority", () => {
    for (const path of ["worktree/service.ts", "delivery/service.ts", "session/service.ts"]) {
      expect(callsGit(path)).toBe(false);
    }
    expect(callsGit("repository/git.ts")).toBe(true);
    for (const path of ["repository/git.ts", "repository/remote.ts"]) {
      expect(importedBindings(path)).not.toEqual(expect.arrayContaining([
        "atomicWrite", "writeFileSync", "mkdirSync", "readJson", "safePath",
      ]));
    }
  });

  it("preserves the compatibility facade while routing reusable boundaries outward", () => {
    expect(exportedFunctionNames("worktree/service.ts")).toContain("loadConfig");
    expect(moduleSpecifiers("worktree/service.ts")).toContain("../repository/remote.js");
    expect(exportedFunctionNames("v2/service.ts")).toEqual(expect.arrayContaining([
      "applyPlan", "rollbackChange",
    ]));
  });
});
