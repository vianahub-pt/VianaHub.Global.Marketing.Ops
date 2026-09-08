import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["automation/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["automation/**/*.ts"],
      exclude: [
        "automation/**/*.test.ts",
        "node_modules/**",
        "dist/**",
        "playwright-report/**",
        "test-results/**",
        "blob-report/**",
        "automation/cli.ts",
        "automation/validate-data.ts",
        "automation/common/types.ts",
        "automation/common/index.ts",
        "automation/playwright/**",
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
