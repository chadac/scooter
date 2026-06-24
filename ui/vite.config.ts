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
    // Proxy the agent-host API to avoid CORS in dev. Mirror the prod nginx
    // proxy (pkgs/ui-image) so the same relative paths work in both.
    proxy: Object.fromEntries(
      ["/agui", "/sessions", "/conversations", "/models"].map((p) => [
        p,
        { target: process.env.AGENT_HOST_URL ?? "http://localhost:8080", changeOrigin: true },
      ]),
    ),
  },
});
