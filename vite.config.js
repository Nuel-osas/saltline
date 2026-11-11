import { defineConfig } from "vite";

// Relative asset paths, so the built game in dist/ runs from any folder or static host.
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 4000 },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
