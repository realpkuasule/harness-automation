import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const tasksPath = process.argv[2];
const overrideSource = process.argv[3];
if (!tasksPath) throw new Error("TASKS_PATH_REQUIRED");
const tasks = readFileSync(resolve(root, tasksPath), "utf8")
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const results = tasks.map((task) => {
  const source = overrideSource ?? task.source;
  const path = resolve(root, source);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const missing = task.requiredStrings.filter((value) => !text.includes(value));
  const forbidden = task.forbiddenStrings.filter((value) => text.includes(value));
  return { id: task.id, source, passed: missing.length === 0 && forbidden.length === 0, missing, forbidden };
});
const score = results.every((result) => result.passed) ? 1 : 0;

console.log(JSON.stringify({ metric: "pass-all-trials", score, trials: results.length, results }, null, 2));
process.exitCode = score === 1 ? 0 : 1;
