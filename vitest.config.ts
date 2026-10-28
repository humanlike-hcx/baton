import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "apps/web/src") },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/server/test/**/*.test.ts", "apps/web/test/**/*.test.tsx"],
    testTimeout: 30000,
    pool: "forks",
  },
});
