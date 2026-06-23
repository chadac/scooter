import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Proxy the AG-UI endpoint to the agent-host in dev to avoid CORS.
    proxy: {
      "/agui": { target: process.env.AGENT_HOST_URL ?? "http://localhost:8080", changeOrigin: true },
      "/sessions": { target: process.env.AGENT_HOST_URL ?? "http://localhost:8080", changeOrigin: true },
    },
  },
});
