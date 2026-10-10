import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The sandbox integration test talks to a live chain; it is skipped unless FEAST_AGENT_SANDBOX=1.
    testTimeout: 20_000,
  },
});
