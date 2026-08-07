import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The suite talks to a real MongoDB. Running files in parallel would let
    // them clear each other's collections mid-assertion, so tests are
    // serialised at the file level. Individual tests within a file still run
    // in order, which the fixtures rely on.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["tests/setup.ts"],
  },
});
