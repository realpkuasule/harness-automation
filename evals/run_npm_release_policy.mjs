import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const overrideSource = process.argv[2];
const tasks = readFileSync(resolve(root, "evals/tasks/npm-release-worktree.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const results = tasks.map((task) => {
  const source = overrideSource ?? task.source;
  const text = readFileSync(resolve(root, source), "utf8");
  const missing = task.requiredStrings.filter((value) => !text.includes(value));
  return { id: task.id, source, passed: missing.length === 0, missing };
});
const score = results.every((result) => result.passed) ? 1 : 0;

console.log(JSON.stringify({ metric: "pass-all-trials", score, trials: results.length, results }, null, 2));
process.exitCode = score === 1 ? 0 : 1;
