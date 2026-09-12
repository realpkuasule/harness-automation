import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // This suite runs many synchronous `git` and native-process fixtures, so the main process can
    // starve and raise `[vitest-worker]: Timeout calling "onTaskUpdate"`, which fails the run by
    // exit code even though every test passes. Measured on a 10-core host: the default worker count
    // failed 3 of 3 runs, while 4 workers failed 1 of 8 — and that one ran alongside a concurrent
    // CLI invocation, with seven idle runs clean. The contention is therefore external load, not a
    // defect in this suite; a dedicated runner does not have it. Cap the pool rather than
    // serializing, which costs far more wall clock. CI stays unaffected at two vCPUs, and
    // `--maxWorkers` on the command line still overrides this.
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/generators/**"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 72,
        statements: 72,
      },
    },
  },
});
