import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4870",
    },
  },
  optimizeDeps: {
    include: ["elkjs/lib/elk-api.js", "elkjs/lib/elk.bundled.js", "graphology"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // elk.bundled.js (main-thread fallback) is ~1.6 MB on its own; it is loaded lazily.
    chunkSizeWarningLimit: 2000,
  },
});
