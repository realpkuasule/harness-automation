import { describe, expect, it } from "vitest";
import { runWithCredential, scrubSensitive, type CredentialRef } from "./service.js";

const ref: CredentialRef = { id: "keychain:one", purpose: "github-api", hostId: "mac", repository: "owner/repo", identity: "octo", scopes: ["issues:write"], expiresAt: "2030-01-01T00:00:00.000Z", envVar: "GH_TOKEN" };
const testAdapter = { probe: (_ref: CredentialRef, env: NodeJS.ProcessEnv) => ({ identity: "octo", repository: "owner/repo", capabilities: env.GH_TOKEN ? ["issues:write"] : [], status: 200 }) };

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

  it("never treats a Git token as an askpass program or invokes a reviewer before DG-02", () => {
    const gitRef: CredentialRef = { ...ref, purpose: "git-transport", envVar: "HARNESS_GIT_TOKEN" };
    expect(() => runWithCredential({
      ref: gitRef, purpose: "git-transport", resolver: { resolve: () => ({ ref: gitRef, secret: "secret" }) },
      command: "git", argv: ["fetch"], requiredCapability: "contents:read",
    })).toThrow("CREDENTIAL_TRANSPORT_HELPER_REQUIRED");
    const reviewer: CredentialRef = { ...ref, purpose: "reviewer", envVar: "HARNESS_REVIEWER_TOKEN" };
    expect(() => runWithCredential({
      ref: reviewer, purpose: "reviewer", resolver: { resolve: () => ({ ref: reviewer, secret: "secret" }) },
      command: "reviewer", argv: [], requiredCapability: "issues:write",
      runner: () => { throw new Error("REVIEWER_MUST_NOT_RUN"); },
    })).toThrow("DG02_REVIEWER_CONFIGURATION_REQUIRED");
  });
});
