import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  cacheDir: process.env.VITE_CACHE_DIR ?? "node_modules/.vite",
  plugins: [react(), tailwindcss()],
  // Define VITE_TELEMETRY_CONSOLE from the environment so it reaches import.meta.env when passed through playwright's webServer.env.
  define: {
    "import.meta.env.VITE_TELEMETRY_CONSOLE": JSON.stringify(process.env.VITE_TELEMETRY_CONSOLE),
  },
  resolve: {
    alias: [
      // One icon module; VITE_ICON_SET picks the set for the mockups.
      { find: /^@\/icons$/, replacement: fileURLToPath(new URL(`./src/icons/${process.env.VITE_ICON_SET ?? "lucide"}.tsx`, import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./", import.meta.url)) },
    ],
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
        ["/agui", "/sessions", "/conversations", "/models", "/whoami", "/scheduled-tasks", "/user-skills", "/users", "/contrib-api"].map((p) => [
          p,
          { target: process.env.AGENT_HOST_URL ?? "http://localhost:8080", changeOrigin: true },
        ]),
      ),
    },
  },
});
