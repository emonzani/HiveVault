import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    globalSetup: ["packages/auth/test/fixtures/generate.ts"],
    testTimeout: 30_000,
    env: { LOG_LEVEL: "error" },
  },
});
