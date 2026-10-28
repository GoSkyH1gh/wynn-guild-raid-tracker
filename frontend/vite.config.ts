import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
  optimizeDeps: {
    include: [
      "apexcharts/line",
      "apexcharts/bar",
      "apexcharts/features/legend",
      "apexcharts/features/toolbar",
    ],
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        legal: fileURLToPath(new URL("./legal.html", import.meta.url)),
        changes: fileURLToPath(new URL("./legal-changes.html", import.meta.url)),
      },
    },
  },
});
