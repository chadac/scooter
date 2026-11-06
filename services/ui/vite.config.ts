import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Define VITE_TELEMETRY_CONSOLE from the environment so it reaches import.meta.env when passed through playwright's webServer.env.
  define: {
    "import.meta.env.VITE_TELEMETRY_CONSOLE": JSON.stringify(process.env.VITE_TELEMETRY_CONSOLE),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Proxy the agent-host API to avoid CORS in dev; every prefix must mirror the prod nginx proxy in services/ui/image/nginx.nix, since a missing path falls through to the SPA.
    proxy: {
      // The e2e fault proxy sets AGENT_HOST_STREAM_URL so only the integrity stream (this regex matches first) routes through it; absent, this points at the same agent-host.
      "^/conversations/[^/]+/events\\.integrity": {
        target: process.env.AGENT_HOST_STREAM_URL ?? process.env.AGENT_HOST_URL ?? "http://localhost:8080",
        changeOrigin: true,
      },
      ...Object.fromEntries(
        ["/agui", "/sessions", "/conversations", "/models", "/whoami", "/scheduled-tasks", "/user-skills", "/users", "/folders", "/contrib-api"].map((p) => [
          p,
          { target: process.env.AGENT_HOST_URL ?? "http://localhost:8080", changeOrigin: true },
        ]),
      ),
    },
  },
});
