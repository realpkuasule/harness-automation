import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // This suite runs many synchronous `git` and native-process fixtures. On a
    // high-core machine vitest's default worker count starves the main process and
    // raises `[vitest-worker]: Timeout calling "onTaskUpdate"`, which fails the run
    // by exit code even though every test passes. Cap the pool instead of serializing:
    // 2 workers is clean but needlessly slow, while the default 10 is not stable here.
    // CI stays unaffected at two vCPUs; `--maxWorkers` on the CLI still overrides this.
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
