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
    // Proxy the agent-host API to avoid CORS in dev. MUST mirror the prod nginx
    // proxy (pkgs/ui-image) EXACTLY — every agent-host API prefix the UI calls.
    // A path missing here falls through to the SPA (index.html 200), so e.g.
    // /whoami returned HTML and the UI was always anonymous in dev (identity, the
    // Mine/All owner filter, and the scheduled-tasks/users pages silently broke
    // only in dev). Keep this list in sync with pkgs/ui-image/default.nix.
    proxy: Object.fromEntries(
      ["/agui", "/sessions", "/conversations", "/models", "/whoami", "/scheduled-tasks", "/users"].map((p) => [
        p,
        { target: process.env.AGENT_HOST_URL ?? "http://localhost:8080", changeOrigin: true },
      ]),
    ),
  },
});
