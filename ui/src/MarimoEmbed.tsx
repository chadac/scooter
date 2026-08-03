/**
 * Renders a marimo ISLAND inline in the chat. The agent's marimo_embed tool emits a
 * ```marimo-embed fenced block whose body is a base64 JSON {islandHtml, headHtml,
 * title}; the markdown renderer (markdown-text.tsx) detects that language and mounts
 * this. We inject the islands runtime assets (headHtml: the @marimo-team/islands
 * main.js module + stylesheet) into <head> ONCE per page, then drop the island HTML
 * in — the runtime hydrates it and runs the cell in the browser via WASM.
 *
 * See services/marimo-mcp (island.ts / encodeEmbedFence) for the payload.
 */

import { useEffect, useMemo, useRef, useState } from "react";

interface EmbedPayload {
  islandHtml: string;
  headHtml: string;
  title?: string | null;
}

/** Parse the base64 JSON body of a ```marimo-embed block. Returns null if it isn't a
 *  valid embed payload (so the caller can fall back to rendering it as plain code). */
export function parseEmbedPayload(base64Body: string): EmbedPayload | null {
  try {
    const json = JSON.parse(atob(base64Body.trim()));
    if (typeof json?.islandHtml !== "string" || typeof json?.headHtml !== "string") return null;
    return { islandHtml: json.islandHtml, headHtml: json.headHtml, title: json.title ?? null };
  } catch {
    return null;
  }
}

/** Injected once per DISTINCT islands runtime URL — a page needs the module + CSS
 *  loaded a single time, no matter how many islands are embedded. */
const injectedHeads = new Set<string>();

/** The islands runtime URL (the <script src>) extracted from a headHtml, or null. */
function islandsScriptSrc(headHtml: string): string | null {
  return headHtml.match(/<script[^>]+src="([^"]+)"/)?.[1] ?? null;
}

/** Inject the head STYLES (the islands stylesheet + fonts/katex) once per runtime.
 *  The runtime SCRIPT itself is loaded via import() in ensureIslandsRuntime (so we get
 *  the module's `initialize` export), not as a plain <script> — a plain <script>'s
 *  auto-init runs ONCE on load and misses islands injected later (our case). */
function injectHeadStyles(headHtml: string) {
  if (typeof document === "undefined") return;
  const key = islandsScriptSrc(headHtml) ?? headHtml;
  if (injectedHeads.has(key)) return;
  injectedHeads.add(key);
  // Add every stylesheet <link> the head declares (islands CSS, fonts, katex).
  for (const m of headHtml.matchAll(/<link[^>]+href="([^"]+)"[^>]*>/g)) {
    const href = m[1];
    if (!/stylesheet/.test(m[0]) && !/\.css/.test(href)) continue;
    if (document.head.querySelector(`link[href="${CSS.escape(href)}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    if (/crossorigin/.test(m[0])) link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }
}

/** The islands runtime module, imported ONCE per script URL. The bundle exports
 *  `initialize()` (designed to be called after injecting islands dynamically — e.g.
 *  client-side nav), which re-scans the DOM + starts the pyodide kernel for reactive
 *  islands. Loading it via import() (not a plain <script>) is what lets us call
 *  initialize AFTER our island is in the DOM — a plain <script>'s one-shot auto-init
 *  on load misses a later-injected island, so the cell never runs (empty plot). */
const runtimeModules = new Map<string, Promise<{ initialize?: () => Promise<void> }>>();

async function ensureIslandsRuntime(headHtml: string): Promise<void> {
  const src = islandsScriptSrc(headHtml);
  if (!src) return;
  let mod = runtimeModules.get(src);
  if (!mod) {
    // @vite-ignore — a runtime CDN URL, not a build-time module.
    mod = import(/* @vite-ignore */ src) as Promise<{ initialize?: () => Promise<void> }>;
    runtimeModules.set(src, mod);
  }
  const m = await mod;
  // Re-discover + start any islands now in the DOM (idempotent; memoized bootstrap).
  await m.initialize?.();
}

/** A PERSISTENT island node cache, keyed by the island HTML. A marimo island is a
 *  custom element that hydrates itself (React root + pyodide) on connect and CANNOT be
 *  cheaply re-created — and the tool result collapses via Radix Collapsible, which
 *  UNMOUNTS its children on close. So we render the island once into a detached <div>
 *  and, on each mount, MOVE that same (already-hydrated) node into the host. Collapse →
 *  the node is re-detached (kept alive here); expand → moved back. No re-hydration, so
 *  the island doesn't vanish. Keyed by islandHtml so identical embeds share one node. */
const islandNodeCache = new Map<string, HTMLDivElement>();

function islandNodeFor(islandHtml: string): HTMLDivElement {
  let node = islandNodeCache.get(islandHtml);
  if (!node) {
    node = document.createElement("div");
    node.className = "marimo-island-node";
    node.innerHTML = islandHtml; // the custom element hydrates itself on connect
    islandNodeCache.set(islandHtml, node);
  }
  return node;
}

export function MarimoEmbed({ base64Body }: { base64Body: string }) {
  const payload = useMemo(() => parseEmbedPayload(base64Body), [base64Body]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // "loading" while the islands runtime + pyodide bootstrap (a few seconds, downloads
  // packages) → a spinner instead of a blank box; cleared when initialize() resolves.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!payload || typeof document === "undefined") return;
    try {
      injectHeadStyles(payload.headHtml);
      // Move the persistent island node into our host. On collapse this component
      // unmounts; the node stays in the cache (detached) — not destroyed — so expanding
      // re-attaches the SAME node.
      const node = islandNodeFor(payload.islandHtml);
      hostRef.current?.appendChild(node);
      // Load the islands runtime and (re)initialize it NOW that our island is in the
      // DOM — this starts the pyodide kernel for the reactive cell so the plot renders.
      // (A plain <script>'s auto-init already ran on load, before our island existed.)
      void ensureIslandsRuntime(payload.headHtml)
        .then(() => setLoading(false))
        .catch(() => {
          setLoading(false);
          setFailed(true);
        });
    } catch {
      setLoading(false);
      setFailed(true);
    }
    // On unmount (collapse), detach the node back to the cache so it's preserved.
    return () => {
      if (!payload) return;
      const node = islandNodeCache.get(payload.islandHtml);
      if (node?.parentNode) node.parentNode.removeChild(node);
    };
  }, [payload]);

  if (!payload) {
    // Not a valid embed — show the raw body so nothing is silently lost.
    return (
      <pre data-testid="marimo-embed-invalid" className="overflow-x-auto rounded-md bg-muted/30 p-3 text-xs">
        {base64Body}
      </pre>
    );
  }

  return (
    <figure data-testid="marimo-embed" className="my-3 rounded-lg border bg-background p-2">
      {payload.title ? (
        <figcaption className="mb-1 px-1 text-xs font-medium text-muted-foreground">{payload.title}</figcaption>
      ) : null}
      {loading && !failed ? (
        <p data-testid="marimo-embed-loading" className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" aria-hidden />
          Loading the interactive cell… (first load fetches the Python runtime)
        </p>
      ) : null}
      {/* The island mounts here (hydrated by the runtime). */}
      <div ref={hostRef} data-testid="marimo-embed-host" className="marimo-island-host" />
      {failed ? (
        <p className="px-1 text-xs text-destructive">Couldn’t render the marimo embed.</p>
      ) : null}
    </figure>
  );
}
