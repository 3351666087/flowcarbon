import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    // creating and dropping a throw-away database waits its turn behind every other test file's
    hookTimeout: 60_000,
  },
});
