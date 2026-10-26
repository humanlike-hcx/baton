import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://127.0.0.1:${process.env.BATON_PORT ?? 47321}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { chunkSizeWarningLimit: 800 },
  server: {
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
});
