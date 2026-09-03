import { execSync } from "node:child_process";

export function prepare(branch: string, path: string): void {
  execSync(`git worktree add -b ${branch} ${path}`);
}
