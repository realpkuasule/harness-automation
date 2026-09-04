import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashObject } from "../v2/fs.js";
import { readLkgChain } from "../receipt/service.js";
import { CREDENTIAL_HOST_BINDING_PATH, applyCredentialHostBinding, loadCredentialHostBinding, macOSKeychainResolver, planCredentialHostBinding, type CredentialBindingPlan, type CredentialHostBinding } from "./host_binding.js";

const roots: string[] = [];
const endpointHash = "a".repeat(64);
const expected = { repository: "owner/repo", repositoryId: "R_1", endpointHash };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "credential-binding-"))); roots.push(root);
  const binding: Omit<CredentialHostBinding, "bindingHash"> = {
    schemaVersion: "credential-host-binding/1.0", commonDir: root, hostId: hostname(), ...expected,
    credentials: [{ id: "keychain:test", purpose: "git-transport", hostId: hostname(), repository: "owner/repo", identity: "octo", scopes: ["contents:read"], expiresAt: "2099-01-01T00:00:00.000Z", envVar: "HARNESS_GIT_TOKEN", keychainService: "svc", keychainAccount: "acct" }],
  };
  return { root, binding, path: join(root, CREDENTIAL_HOST_BINDING_PATH) };
}
function lkg(root: string) { return readLkgChain({ root, domain: "credential-binding" }); }
function writeProjection(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}
function apply(root: string, plan: CredentialBindingPlan) { return applyCredentialHostBinding(root, plan, plan.planHash); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

describe("credential host binding", () => {
  it("requires an approved receipt and loads the exact current binding privately", () => {
    const { root, binding, path } = fixture();
    writeProjection(path, { ...binding, bindingHash: hashObject(binding) });
    expect(() => loadCredentialHostBinding(root, expected)).toThrow();
    const plan = planCredentialHostBinding(root, binding);
    expect(() => applyCredentialHostBinding(root, plan, "bad")).toThrow();
    expect(lkg(root)).toHaveLength(0);
    apply(root, plan);
    expect(loadCredentialHostBinding(root, expected)).toEqual(plan.binding);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    apply(root, plan);
    expect(lkg(root)).toHaveLength(1);
  });

  it("rejects unknown fields, malformed refs, duplicate refs and wrong host before writing", () => {
    const { root, binding } = fixture();
    for (const bad of [
      { ...binding, secret: "must-not-persist" },
      { ...binding, hostId: "another-host" },
      { ...binding, commonDir: join(root, "elsewhere") },
      { ...binding, credentials: [] },
      { ...binding, credentials: [...binding.credentials, ...binding.credentials] },
      { ...binding, credentials: [{ ...binding.credentials[0], envVar: "GH_TOKEN" }] },
      { ...binding, credentials: [{ ...binding.credentials[0], expiresAt: "2000-01-01T00:00:00.000Z" }] },
      { ...binding, credentials: [{ ...binding.credentials[0], keychainService: "bad\nservice" }] },
    ]) expect(() => planCredentialHostBinding(root, bad as typeof binding)).toThrow();
    expect(lkg(root)).toHaveLength(0);
  });

  it("rejects endpoint and repository drift on every load", () => {
    const { root, binding } = fixture();
    apply(root, planCredentialHostBinding(root, binding));
    for (const bad of [{ ...expected, endpointHash: "b".repeat(64) }, { ...expected, repositoryId: "wrong" }, { ...expected, repository: "other/repo" }]) {
      expect(() => loadCredentialHostBinding(root, bad)).toThrow();
    }
  });

  it("does not authorize a previous projection or a tampered LKG", () => {
    const { root, binding, path } = fixture();
    const first = planCredentialHostBinding(root, binding); apply(root, first);
    const second = planCredentialHostBinding(root, { ...binding, credentials: [{ ...binding.credentials[0], keychainAccount: "new" }] }); apply(root, second);
    writeProjection(path, first.binding);
    expect(() => loadCredentialHostBinding(root, expected)).toThrow();
    writeProjection(path, second.binding);
    const record = join(root, "harness/lkg/credential-binding/records/000000000002.json");
    writeFileSync(record, "{}");
    expect(() => loadCredentialHostBinding(root, expected)).toThrow("LKG_CHAIN_TAMPERED");
  });

  it("recovers authority after projection loss without replaying registration", () => {
    const { root, binding, path } = fixture();
    const plan = planCredentialHostBinding(root, binding); apply(root, plan);
    rmSync(path);
    expect(loadCredentialHostBinding(root, expected)).toEqual(plan.binding);
    expect(existsSync(path)).toBe(false);
    apply(root, plan);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(plan.binding);
    expect(lkg(root)).toHaveLength(1);
  });

  it("rejects drifted or expired plans without appending evidence", () => {
    const { root, binding, path } = fixture();
    const plan = planCredentialHostBinding(root, binding);
    writeProjection(path, { changed: true });
    expect(() => apply(root, plan)).toThrow();
    expect(lkg(root)).toHaveLength(0);
    const expired = { ...planCredentialHostBinding(root, binding), createdAt: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T00:15:00.000Z" };
    const content: Partial<typeof expired> = { ...expired }; delete content.planHash;
    expired.planHash = hashObject(content);
    expect(() => apply(root, expired)).toThrow();
    expect(lkg(root)).toHaveLength(0);
  });

  it("blocks expired credentials without self-locking their explicitly approved replacement", () => {
    const { root, binding } = fixture();
    apply(root, planCredentialHostBinding(root, binding));
    vi.useFakeTimers(); vi.setSystemTime(new Date("2100-01-01T00:00:00Z"));
    expect(() => loadCredentialHostBinding(root, expected)).toThrow();
    const renewed = { ...binding, credentials: [{ ...binding.credentials[0], expiresAt: "2101-01-01T00:00:00.000Z" }] };
    apply(root, planCredentialHostBinding(root, renewed));
    expect(loadCredentialHostBinding(root, expected).credentials[0].expiresAt).toBe(renewed.credentials[0].expiresAt);
  });

  it("rejects both live and dangling symlinks and permissive projections", () => {
    for (const dangling of [false, true]) {
      const { root, binding, path } = fixture();
      const target = join(root, "outside");
      if (!dangling) writeFileSync(target, "{}");
      mkdirSync(join(path, ".."), { recursive: true }); symlinkSync(target, path);
      expect(() => planCredentialHostBinding(root, binding)).toThrow();
      expect(() => loadCredentialHostBinding(root, expected)).toThrow();
    }
    const { root, binding, path } = fixture(); apply(root, planCredentialHostBinding(root, binding));
    chmodSync(path, 0o644);
    expect(() => loadCredentialHostBinding(root, expected)).toThrow();
  });

  it("serializes independent-process competing plans with the shared mutation lock", async () => {
    const { root, binding } = fixture();
    const first = planCredentialHostBinding(root, binding);
    const second = planCredentialHostBinding(root, { ...binding, credentials: [{ ...binding.credentials[0], keychainAccount: "competitor" }] });
    const source = new URL("./host_binding.ts", import.meta.url).href;
    const run = (plan: CredentialBindingPlan) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {applyCredentialHostBinding as apply} from ${JSON.stringify(source)};try{const p=JSON.parse(process.argv[2]);apply(process.argv[1],p,p.planHash);}catch{process.exitCode=1;}`, root, JSON.stringify(plan)], { stdio: "ignore" });
      child.once("error", reject); child.once("exit", resolve);
    });
    expect((await Promise.all([run(first), run(second)])).sort()).toEqual([0, 1]);
    expect(lkg(root)).toHaveLength(1);
    expect(loadCredentialHostBinding(root, expected).bindingHash).toBe(lkg(root)[0].observedHash);
  });

  it("rejects mismatched refs and stale resolvers before reading the keychain", () => {
    const { root, binding } = fixture();
    const plan = planCredentialHostBinding(root, binding); apply(root, plan);
    const resolver = macOSKeychainResolver(loadCredentialHostBinding(root, expected));
    if (process.platform !== "darwin") {
      expect(() => resolver.resolve(binding.credentials[0])).toThrow("CREDENTIAL_OS_ADAPTER_UNAVAILABLE"); return;
    }
    const bin = join(root, "bin"); mkdirSync(bin);
    const marker = join(root, "keychain-reads");
    const tool = join(bin, "security");
    writeFileSync(tool, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)},'read\\n');process.stdout.write('synthetic-only\\n');\n`, { mode: 0o700 });
    vi.stubEnv("PATH", bin);
    expect(resolver.resolve(binding.credentials[0]).secret).toBe("synthetic-only");
    expect(() => resolver.resolve({ ...binding.credentials[0], hostId: "wrong-host" })).toThrow();
    expect(readFileSync(marker, "utf8")).toBe("read\n");
    apply(root, planCredentialHostBinding(root, { ...binding, credentials: [{ ...binding.credentials[0], keychainAccount: "replacement" }] }));
    expect(() => resolver.resolve(binding.credentials[0])).toThrow();
    expect(readFileSync(marker, "utf8")).toBe("read\n");
  });
});
