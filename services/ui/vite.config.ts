import { defineConfig, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const BUILD_PLACEHOLDER = "__SCOOTER_BUILD__";

/** Stamps the build id src/appUpdate.ts compares into the output. */
function buildId(): Plugin {
  return {
    name: "scooter-build-id",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: "scooter-build", content: BUILD_PLACEHOLDER }, injectTo: "head" }],
    // The dev page and version.json share the placeholder: no update.
    configureServer(server) {
      server.middlewares.use("/version.json", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ build: BUILD_PLACEHOLDER }));
      });
    },
    generateBundle: {
      order: "post",
      handler(_opts, bundle) {
        // Emitted names carry content hashes, so they identify the build.
        const names = Object.keys(bundle).filter((n) => n !== "index.html").sort();
        const build = createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 16);
        const html = bundle["index.html"];
        if (html?.type !== "asset") throw new Error("scooter-build-id: no index.html in the bundle");
        html.source = String(html.source).replace(BUILD_PLACEHOLDER, build);
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build }) });
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), buildId()],
  // One deps cache per dev server; a shared one races.
  cacheDir: process.env.VITE_CACHE_DIR ?? "node_modules/.vite",
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
        ["/agui", "/sessions", "/conversations", "/models", "/whoami", "/scheduled-tasks", "/user-skills", "/user-hooks", "/sandbox-sizes", "/themes", "/user-theme", "/remote-agent", "/users", "/folders", "/contrib-api"].map((p) => [
          p,
          { target: process.env.AGENT_HOST_URL ?? "http://localhost:8080", changeOrigin: true },
        ]),
      ),
    },
  },
});
