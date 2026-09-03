import { spawnSync } from "node:child_process";

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export function runGit(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; fallbackError?: boolean } = {},
): string {
  const result = spawnSync("git", args, {
    cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    const detail = options.fallbackError
      ? (result.stderr || result.error?.message || "unknown error").trim()
      : `${result.stderr ?? result.stdout ?? result.error ?? ""}`.trim();
    throw new Error(`GIT_COMMAND_FAILED: git ${args.join(" ")}: ${detail}`);
  }
  return result.status === 0 ? result.stdout : "";
}

export function runGitCommand(cwd: string, args: string[], env: NodeJS.ProcessEnv): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "buffer",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr ?? ""),
    error: result.error ? result.error.message : null,
  };
}

export function runGitToFile(cwd: string, args: string[], output: number, allowFailure = false): number | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", output, "pipe"],
    timeout: 30_000,
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const detail = `${result.stderr ?? result.error ?? ""}`.trim();
    throw new Error(`GIT_COMMAND_FAILED: git ${args.join(" ")}: ${detail}`);
  }
  return result.status;
}
