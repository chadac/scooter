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
    proxy: {
      // The e2e SSE-resilience harness sets AGENT_HOST_STREAM_URL to a fault proxy
      // so it can drop/stall/kill INTEGRITY-STREAM frames — but ONLY the stream:
      // everything else (POST /agui, /conversations, /tail, …) still goes straight
      // to agent-host. Chaining ALL traffic through the extra proxy hop raced the
      // long-lived SSE against concurrent POSTs and 400'd multi-turn sends. This
      // regex (more specific → matched first) carves the integrity stream out to
      // the stream target; the general /conversations entry below handles the rest.
      // Absent AGENT_HOST_STREAM_URL, it just points at the same agent-host (no-op).
      "^/conversations/[^/]+/events\\.integrity": {
        target: process.env.AGENT_HOST_STREAM_URL ?? process.env.AGENT_HOST_URL ?? "http://localhost:8080",
        changeOrigin: true,
      },
      ...Object.fromEntries(
        ["/agui", "/sessions", "/conversations", "/models", "/whoami", "/scheduled-tasks", "/users"].map((p) => [
          p,
          { target: process.env.AGENT_HOST_URL ?? "http://localhost:8080", changeOrigin: true },
        ]),
      ),
    },
  },
});
