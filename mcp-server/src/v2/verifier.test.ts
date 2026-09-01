import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkGo,
  checkPython,
  checkTypeScript,
  checkTypeScriptSource,
  goCacheDirectory,
  inspectTypeScriptSource,
} from "./verifier.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harness-verifier-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("naming verifiers", () => {
  it("uses a distinct fallback Go cache for each service account", () => {
    expect(goCacheDirectory({}, 1001)).toBe(join(tmpdir(), "harness-automation-go-build-uid-1001"));
    expect(goCacheDirectory({}, 1002)).toBe(join(tmpdir(), "harness-automation-go-build-uid-1002"));
    expect(goCacheDirectory({ GOCACHE: "/custom/go-cache" }, 1001)).toBe("/custom/go-cache");
  });

  it("reports parser and naming violations across declarations, patterns, members, and imports", () => {
    expect(checkTypeScriptSource("const = ;", "broken.ts")[0]).toContain("broken.ts: parse error:");
    const violations = checkTypeScriptSource(`
      import bad_import, * as bad_namespace from "module";
      const { bad_object, ok: [bad_array = 1], ...bad_rest } = value;
      const Bad_value = 1;
      const Component = (Bad_Arrow: string) => Bad_Arrow;
      function Bad_function({ bad_parameter }: { bad_parameter: string }) { return bad_parameter; }
      class bad_class { Bad_field = 1; Bad_method() {} constructor() {} }
      interface bad_interface {}
      type bad_type = string;
      enum bad_enum { Value }
    `, "fixture.ts");

    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining("bad_import"),
      expect.stringContaining("bad_namespace"),
      expect.stringContaining("bad_object"),
      expect.stringContaining("bad_array"),
      expect.stringContaining("bad_rest"),
      expect.stringContaining("Bad_value"),
      expect.stringContaining("Bad_Arrow"),
      expect.stringContaining("Bad_function"),
      expect.stringContaining("bad_class"),
      expect.stringContaining("Bad_field"),
      expect.stringContaining("Bad_method"),
      expect.stringContaining("bad_interface"),
      expect.stringContaining("bad_type"),
      expect.stringContaining("bad_enum"),
    ]));

    const destructuring = checkTypeScriptSource(`
      import { name as bad_named } from "module";
      const [bad_assignment = 1, , ...bad_rest] = values;
      const { short: bad_object } = value;
      function bad_function(...bad_parameter: string[]) { return bad_parameter; }
    `, "patterns.ts");
    expect(destructuring).toEqual(expect.arrayContaining([
      expect.stringContaining("bad_named"),
      expect.stringContaining("bad_assignment"),
      expect.stringContaining("bad_rest"),
      expect.stringContaining("bad_object"),
      expect.stringContaining("bad_function"),
      expect.stringContaining("bad_parameter"),
    ]));
  });

  it("classifies supported constants, Node identifiers, placeholders, and exported Zod schemas", () => {
    const violations = checkTypeScriptSource(`
      import { z } from "zod";
      import { MODULE_CONSTANT } from "module";
      export const UserInputSchema = z.object({});
      const __filename = "file";
      const __dirname = "dir";
      const MODULE_VALUE = 1;
      function callback(_: string) {}
      class Registry { static readonly KNOWN_VALUES = new Set(); }
      let MUTABLE_VALUE = 1;
      function local() { const LOCAL_VALUE = 1; }
      const RuntimeValue = z.object({});
      const HiddenSchema = z.object({});
    `, "legal-categories.ts");

    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining("MUTABLE_VALUE"),
      expect.stringContaining("LOCAL_VALUE"),
      expect.stringContaining("RuntimeValue"),
      expect.stringContaining("HiddenSchema"),
    ]));
    for (const legal of ["MODULE_CONSTANT", "UserInputSchema", "__filename", "__dirname", "MODULE_VALUE", "'_'", "KNOWN_VALUES"]) {
      expect(violations.join("\n")).not.toContain(legal);
    }
  });

  it("uses line-stable, rule-bound fingerprints and distinguishes duplicate violations", () => {
    const original = inspectTypeScriptSource("const legacy_name = 1;\n", "src/value.ts")[0];
    const moved = inspectTypeScriptSource("\n\nconst legacy_name = 1;\n", "src/value.ts")[0];
    const renamed = inspectTypeScriptSource("const changed_name = 1;\n", "src/value.ts")[0];
    const relocated = inspectTypeScriptSource("const legacy_name = 1;\n", "src/other.ts")[0];
    const changedRole = inspectTypeScriptSource("function use(legacy_name: string) {}\n", "src/value.ts")[0];
    const duplicates = inspectTypeScriptSource(
      "function first(legacy_name: string) {}\nfunction second(legacy_name: string) {}\n",
      "src/value.ts",
    );

    expect(original.ruleId).toBe("typescript-naming");
    expect(original.fingerprint).toBe(moved.fingerprint);
    expect(new Set([original.fingerprint, renamed.fingerprint, relocated.fingerprint, changedRole.fingerprint]).size).toBe(4);
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0].fingerprint).toBe(duplicates[1].fingerprint);
    expect(inspectTypeScriptSource("const = ;", "broken.ts")[0].fingerprint).toBeNull();

    const projectRoot = root();
    writeFileSync(join(projectRoot, "duplicate.ts"),
      "function first(legacy_name: string) {}\nfunction second(legacy_name: string) {}\n");
    const approvedOne = inspectTypeScriptSource(
      "function first(legacy_name: string) {}\nfunction second(legacy_name: string) {}\n",
      "duplicate.ts",
    )[0].fingerprint!;
    expect(checkTypeScript(projectRoot, {
      ruleId: "typescript-naming",
      approvedIntakeHash: "a".repeat(64),
      fingerprints: [approvedOne],
    })).toMatchObject({ passing: false, violations: [expect.stringContaining("legacy_name")] });
  });

  it("scans only TypeScript sources and skips declarations, ignored directories, and symlinks", () => {
    const projectRoot = root();
    writeFileSync(join(projectRoot, "valid.ts"), "const validName = 1;\n");
    writeFileSync(join(projectRoot, "invalid.tsx"), "const bad_name = 1;\n");
    writeFileSync(join(projectRoot, "types.d.ts"), "declare const bad_name: string;\n");
    mkdirSync(join(projectRoot, "node_modules"));
    writeFileSync(join(projectRoot, "node_modules", "ignored.ts"), "const bad_name = 1;\n");
    symlinkSync(join(projectRoot, "invalid.tsx"), join(projectRoot, "linked.ts"));

    expect(checkTypeScript(projectRoot)).toMatchObject({ enforced: true, passing: false, violations: [
      expect.stringContaining("invalid.tsx"),
    ] });
  });

  it("reports configured and unconfigured external naming checkers", () => {
    const projectRoot = root();
    expect(checkPython(projectRoot)).toMatchObject({ enforced: false, passing: false, detail: "Python naming checker is not configured" });
    expect(checkGo(projectRoot)).toMatchObject({ enforced: false, passing: false, detail: "Go naming checker is not configured" });

    const generated = join(projectRoot, ".harness", "generated");
    mkdirSync(generated, { recursive: true });
    const checker = join(generated, "check_python_naming.py");
    writeFileSync(checker, "import sys\nif '--self-test' in sys.argv: raise SystemExit(1)\nprint('naming violation')\nraise SystemExit(1)\n");
    chmodSync(checker, 0o755);

    expect(checkPython(projectRoot)).toMatchObject({ enforced: true, passing: false, violations: ["naming violation"] });
  });
});
