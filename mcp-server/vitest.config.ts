import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
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
