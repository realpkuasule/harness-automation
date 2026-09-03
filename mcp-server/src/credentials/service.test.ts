import { describe, expect, it } from "vitest";
import { runWithCredential, type CredentialRef } from "./service.js";

const ref: CredentialRef = { id: "keychain:one", purpose: "github-api", hostId: "mac", repository: "owner/repo", identity: "octo", scopes: ["issues:write"], expiresAt: "2030-01-01T00:00:00.000Z", envVar: "GH_TOKEN" };

describe("credentials", () => {
  it("isolates each purpose and redacts all returned output", () => {
    const result = runWithCredential({
      ref, purpose: "github-api", resolver: { resolve: () => ({ ref, secret: "secret-canary" }) }, command: "fake", argv: [], requiredCapability: "issues:write",
      probe: { probe: (_ref, env) => ({ identity: "octo", repository: "owner/repo", capabilities: env.GH_TOKEN ? ["issues:write"] : [], status: 200 }) },
      runner: (_command, _argv, env) => ({ status: 0, stdout: `${env.GH_TOKEN} output`, stderr: `${env.GH_TOKEN} error` } as never),
    });
    expect(JSON.stringify(result)).not.toContain("secret-canary");
    expect(result.credentialRef).toBe("keychain:one");
    expect(() => runWithCredential({
      ref: { ...ref, purpose: "reviewer" }, purpose: "github-api", resolver: { resolve: () => ({ ref, secret: "secret" }) }, command: "fake", argv: [], requiredCapability: "issues:write",
      probe: { probe: () => ({ identity: "octo", repository: "owner/repo", capabilities: ["issues:write"], status: 403 }) },
    })).toThrow("CREDENTIAL_INVALID");
  });
});
