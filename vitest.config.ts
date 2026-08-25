import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});