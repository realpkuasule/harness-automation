import { sha256 } from "../v2/fs.js";
import { runGitCommand } from "./git.js";

export function remotePushEndpoint(root: string, remote: string): { value: string; hash: string } {
  const result = runGitCommand(root, ["remote", "get-url", "--push", "--all", remote], process.env);
  if (result.status !== 0) throw new Error(`REMOTE_PUSH_ENDPOINT_UNAVAILABLE: ${remote}`);
  const endpoints = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (endpoints.length !== 1) throw new Error(`REMOTE_PUSH_ENDPOINT_AMBIGUOUS: ${remote}`);
  const rewrites = runGitCommand(root, [
    "config",
    "-z",
    "--get-regexp",
    "^url\\..*\\.(insteadof|pushinsteadof)$",
  ], process.env);
  if (rewrites.status !== 0 && rewrites.status !== 1) {
    throw new Error(`REMOTE_PUSH_ENDPOINT_UNAVAILABLE: ${remote}`);
  }
  const prefixes = rewrites.stdout.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\n");
    if (separator === -1) throw new Error(`REMOTE_PUSH_ENDPOINT_UNAVAILABLE: ${remote}`);
    return entry.slice(separator + 1);
  });
  if (prefixes.some((prefix) => endpoints[0].startsWith(prefix))) {
    throw new Error(`REMOTE_PUSH_ENDPOINT_UNSTABLE: ${remote}`);
  }
  return { value: endpoints[0], hash: sha256(endpoints[0]) };
}

export function remoteRefHead(root: string, endpoint: string, remote: string, ref: string): string | null {
  const observed = runGitCommand(root, ["ls-remote", "--heads", endpoint, ref], process.env);
  if (observed.status !== 0) {
    const detail = (observed.stderr || observed.error || "unknown error").replaceAll(endpoint, "<remote>");
    throw new Error(`REMOTE_BRANCH_OBSERVATION_FAILED: ${remote} ${ref}: ${detail}`);
  }
  const lines = observed.stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length !== 1) throw new Error(`REMOTE_BRANCH_AMBIGUOUS: ${remote} ${ref}`);
  const [head, observedRef] = lines[0].split(/\s+/u, 2);
  if (observedRef !== ref || !/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new Error(`REMOTE_BRANCH_OBSERVATION_INVALID: ${remote} ${ref}`);
  }
  return head;
}

export function githubEndpointRepository(endpoint: string, remote: string): string {
  const scp = endpoint.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/iu);
  let repository = scp?.[1];
  if (!repository) {
    try {
      const url = new URL(endpoint);
      if (url.hostname.toLowerCase() === "github.com") {
        repository = url.pathname.replace(/^\//u, "").replace(/\.git\/?$/u, "").replace(/\/$/u, "");
      }
    } catch {
      // Non-URL push targets cannot prove a GitHub repository identity.
    }
  }
  if (!repository || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error(`GITHUB_REMOTE_REPOSITORY_MISMATCH: ${remote}`);
  }
  return repository;
}
