import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "supabase/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
