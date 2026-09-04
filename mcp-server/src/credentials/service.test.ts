import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWithCredential, scrubSensitive, type CredentialRef } from "./service.js";

const ref: CredentialRef = { id: "keychain:one", purpose: "github-api", hostId: "mac", repository: "owner/repo", identity: "octo", scopes: ["issues:write"], expiresAt: "2030-01-01T00:00:00.000Z", envVar: "GH_TOKEN" };
const testAdapter = { probe: (_ref: CredentialRef, env: NodeJS.ProcessEnv) => ({ identity: "octo", repository: "owner/repo", capabilities: env.GH_TOKEN ? ["issues:write"] : [], status: 200 }) };
const temporary: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe("credentials", () => {
  it("uses a resolver-bound session, a test-only probe seam, minimal env, and scrubbed output", () => {
    const result = runWithCredential({
      ref, purpose: "github-api", resolver: { resolve: () => ({ ref, secret: "secret-canary" }) }, command: "fake", argv: [], requiredCapability: "issues:write", testAdapter,
      runner: (_command, _argv, env) => {
        expect(Object.keys(env).sort()).toEqual(["CI", "GH_TOKEN", "PATH"]);
        return { status: 0, stdout: `${env.GH_TOKEN} output`, stderr: `Bearer abc.def GH_TOKEN=${env.GH_TOKEN}` } as never;
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-canary");
    expect(result).toMatchObject({ credentialRef: "keychain:one", identity: "octo", expiresAt: ref.expiresAt });
  });

  it("binds every resolver metadata field and rejects denial, expiry, and unavailable stores", () => {
    for (const field of ["purpose", "hostId", "repository", "identity", "scopes", "expiresAt", "envVar"] as const) {
      expect(() => runWithCredential({
        ref, purpose: "github-api", resolver: { resolve: () => ({ ref: { ...ref, [field]: field === "scopes" ? ["repo"] : field === "expiresAt" ? "2031-01-01T00:00:00.000Z" : "wrong" } as CredentialRef, secret: "secret" }) },
        command: "fake", argv: [], requiredCapability: "issues:write", testAdapter,
      })).toThrow("CREDENTIAL_RESOLUTION_FAILED");
    }
    expect(() => runWithCredential({
      ref: { ...ref, expiresAt: "not-a-date" }, purpose: "github-api", resolver: { resolve: () => ({ ref: { ...ref, expiresAt: "not-a-date" }, secret: "secret" }) },
      command: "fake", argv: [], requiredCapability: "issues:write", testAdapter,
    })).toThrow("CREDENTIAL_INVALID");
    expect(() => runWithCredential({
      ref, purpose: "github-api", resolver: { resolve: () => { throw new Error("keychain unavailable"); } }, command: "fake", argv: [], requiredCapability: "issues:write", testAdapter,
    })).toThrow("ENVIRONMENT_BLOCKED: CREDENTIAL_STORE_UNAVAILABLE");
    expect(() => runWithCredential({
      ref, purpose: "github-api", resolver: { resolve: () => ({ ref, secret: "secret" }) }, command: "fake", argv: [], requiredCapability: "issues:write",
      testAdapter: { probe: () => ({ identity: "octo", repository: "owner/repo", capabilities: [], status: 403 }) },
    })).toThrow("CREDENTIAL_ACCESS_DENIED");
  });

  it("scrubs bearer, headers, environment names, and JSON secrets from exceptions", () => {
    const secret = "secret-canary";
    const source = `Bearer abc.def Authorization: token GH_TOKEN=${secret} {"token":"${secret}","refresh_token":"r"}`;
    const scrubbed = scrubSensitive(source, [secret]);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).not.toContain("abc.def");
    expect(scrubbed).not.toContain('"r"');
  });

  it("uses a token-scoped HTTPS transport without askpass or inherited credential helpers", () => {
    const gitRef: CredentialRef = { ...ref, purpose: "git-transport", envVar: "HARNESS_GIT_TOKEN" };
    runWithCredential({
      ref: gitRef, purpose: "git-transport", resolver: { resolve: () => ({ ref: gitRef, secret: "secret" }) },
      command: "git", argv: ["ls-remote", "https://github.com/owner/repo.git"], requiredCapability: "contents:read",
      testAdapter: { probe: () => ({ identity: "octo", repository: "owner/repo", capabilities: ["contents:read"], status: 200 }) },
      runner: (_command, _argv, env) => { expect(env.GIT_ASKPASS).toBeUndefined(); expect(env.GIT_CONFIG_VALUE_0).toBe(""); expect(env.GIT_CONFIG_KEY_1).toContain("extraheader"); expect(env.GIT_CONFIG_VALUE_1).not.toContain("secret"); return { status: 0, stdout: "", stderr: "" } as never; },
    });
  });

  it("keeps raw and base64 token canaries out of the fixed probe argv and scrubbed output", () => {
    const bin = mkdtempSync(join(tmpdir(), "harness-gh-probe-")); temporary.push(bin); const captured = join(bin, "argv.json");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);const p=${JSON.stringify(captured)};const old=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):[];old.push(a);fs.writeFileSync(p,JSON.stringify(old));if(a.includes('user'))process.stdout.write('HTTP/2 200\\nx-oauth-scopes: contents:read\\n\\n{"login":"octo"}');else process.stdout.write('{"full_name":"owner/repo"}');\n`, "utf8"); chmodSync(join(bin, "gh"), 0o755); process.env.PATH = `${bin}${delimiter}${originalPath}`;
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);const p=${JSON.stringify(captured)};const old=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):[];old.push(a);fs.writeFileSync(p,JSON.stringify(old));process.stdout.write(a.some(x=>x.includes('/repos/'))?'{"full_name":"owner/repo"}':'HTTP/2 200\\nx-oauth-scopes: contents:read\\n\\n{"login":"octo"}');\n`, "utf8"); chmodSync(join(bin, "curl"), 0o755);
    const gitRef: CredentialRef = { ...ref, purpose: "git-transport", envVar: "HARNESS_GIT_TOKEN", scopes: ["contents:read"] };
    const secret = "raw-canary"; const encoded = Buffer.from(`x-access-token:${secret}`).toString("base64");
    const result = runWithCredential({ ref: gitRef, purpose: "git-transport", resolver: { resolve: () => ({ ref: gitRef, secret }) }, command: "git", argv: ["ls-remote"], requiredCapability: "contents:read", runner: () => ({ status: 0, stdout: encoded, stderr: `Basic ${encoded}` } as never) });
    expect(JSON.stringify(readFileSync(captured, "utf8"))).not.toContain(secret); expect(readFileSync(captured, "utf8")).not.toContain(encoded); expect(JSON.stringify(result)).not.toContain(encoded);
  });

  it("scrubs a derived Git credential from nonzero child output", () => {
    const gitRef: CredentialRef = { ...ref, purpose: "git-transport", envVar: "HARNESS_GIT_TOKEN", scopes: ["contents:read"] }; const secret = "failure-canary"; const encoded = Buffer.from(`x-access-token:${secret}`).toString("base64");
    expect(() => runWithCredential({ ref: gitRef, purpose: "git-transport", resolver: { resolve: () => ({ ref: gitRef, secret }) }, command: "git", argv: [], requiredCapability: "contents:read", testAdapter: { probe: () => ({ identity: "octo", repository: "owner/repo", capabilities: ["contents:read"], status: 200 }) }, runner: () => ({ status: 1, stdout: "", stderr: encoded } as never) })).toThrow("[REDACTED]");
    try { runWithCredential({ ref: gitRef, purpose: "git-transport", resolver: { resolve: () => ({ ref: gitRef, secret }) }, command: "git", argv: [], requiredCapability: "contents:read", testAdapter: { probe: () => ({ identity: "octo", repository: "owner/repo", capabilities: ["contents:read"], status: 200 }) }, runner: () => ({ status: 1, stdout: "", stderr: encoded } as never) }); } catch (error) { expect(String(error)).not.toContain(encoded); }
  });

  it("never invokes a reviewer before DG-02", () => {
    const reviewer: CredentialRef = { ...ref, purpose: "reviewer", envVar: "HARNESS_REVIEWER_TOKEN" };
    expect(() => runWithCredential({
      ref: reviewer, purpose: "reviewer", resolver: { resolve: () => ({ ref: reviewer, secret: "secret" }) },
      command: "reviewer", argv: [], requiredCapability: "issues:write",
      testAdapter: { probe: () => { throw new Error("TEST_PROBE_MUST_NOT_RUN"); } },
      runner: () => { throw new Error("REVIEWER_MUST_NOT_RUN"); },
    })).toThrow("DG02_REVIEWER_CONFIGURATION_REQUIRED");
  });
});
