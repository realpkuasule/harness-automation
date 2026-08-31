import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGo, checkPython, checkTypeScript, checkTypeScriptSource, goCacheDirectory } from "./verifier.js";

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
