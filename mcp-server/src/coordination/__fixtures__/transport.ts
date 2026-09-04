import { runGitCommand } from "../../repository/git.js";
import type { CoordinationTransport } from "../store.js";
import { coordinationHistoryCheck, type HistoryCheck } from "../history.js";
import { prepareSyntheticObject, type SyntheticObjectPlan } from "../synthetic.js";
import { objectGit } from "../objects.js";

export const fixtureGenesis = () => prepareSyntheticObject("control-genesis", { runId: "local-fixture", objectId: "genesis", seconds: 1788480000 });
export function localHistory(commonDir: string, controlRef: string, genesis: SyntheticObjectPlan, repositoryId = "R_1"): HistoryCheck {
  return coordinationHistoryCheck(commonDir, { validationVersion: "coordination-history/2", genesis, endpointHash: "a".repeat(64), repository: "owner/repo", repositoryId, controlRef });
}
/** Fixture setup only, explicitly confined to an owned LOCAL bare repository. Not qualification evidence. */
export function seedLocalGenesis(remote: string, controlRef: string): SyntheticObjectPlan {
  if (!remote.startsWith("/") || !remote.endsWith(".git")) throw new Error("FIXTURE_LOCAL_ENDPOINT_REQUIRED");
  const genesis = fixtureGenesis();
  objectGit(remote, ["hash-object", "-w", "-t", "tree", "--stdin"], "");
  objectGit(remote, ["hash-object", "-w", "-t", "commit", "--stdin"], genesis.commitText);
  objectGit(remote, ["update-ref", controlRef, genesis.commitSha, "0".repeat(40)]);
  return genesis;
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
