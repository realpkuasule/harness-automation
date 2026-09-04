import { runGitCommand } from "../../repository/git.js";
import type { CoordinationTransport } from "../store.js";
import { validateCoordinationHistory, type HistoryCheck } from "../history.js";

export function localHistory(commonDir: string, controlRef: string, genesis: () => string): HistoryCheck {
  return (head, readValidatedCommit, isAncestor) => {
    const result = validateCoordinationHistory({ commonDir, anchor: { validationVersion: "coordination-history/1", genesisSha: genesis(), repository: "owner/repo", repositoryId: "R_1", controlRef }, head, readValidatedCommit, isAncestor });
    if (result.status !== "verified") throw new Error("COORDINATION_HISTORY_VALIDATION_PENDING");
  };
}

/** LOCAL bare repositories only. Never selected by a production flag or environment variable. */
export function localTransport(root: string, endpoint: string): CoordinationTransport {
  if (!endpoint.startsWith("/") || !endpoint.endsWith(".git")) throw new Error("FIXTURE_LOCAL_ENDPOINT_REQUIRED");
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  return {
    repository: "owner/repo", repositoryId: "R_1",
    readRef(ref) {
      const result = runGitCommand(root, ["ls-remote", endpoint, ref], env);
      if (result.error || result.status !== 0) throw new Error("COORDINATION_REMOTE_OBSERVATION_FAILED");
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      if (!lines.length) return null;
      const [sha, observed] = lines[0].split(/\s+/u);
      if (lines.length !== 1 || observed !== ref) throw new Error("COORDINATION_REMOTE_OBSERVATION_INVALID");
      return sha;
    },
    fetch(directory, sha) {
      const result = runGitCommand(directory, ["fetch", "--no-tags", "--quiet", endpoint, sha], env);
      if (result.error || result.status !== 0) throw new Error("COORDINATION_FETCH_FAILED");
    },
    push(directory, sha, ref, expected) {
      return runGitCommand(directory, ["push", "--porcelain", `--force-with-lease=${ref}:${expected ?? ""}`, endpoint, `${sha}:${ref}`], env);
    },
  };
}
