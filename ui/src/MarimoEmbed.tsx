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

/** Inject the head assets (parsed from headHtml) into document.head once. headHtml is
 *  a `<script type="module" src=".../islands@X/main.js">` + a stylesheet `<link>`; we
 *  extract the URLs and add real <script>/<link> elements (setting innerHTML on <head>
 *  wouldn't execute a module script). Keyed on the script src so a second embed on the
 *  same runtime version is a no-op. */
function injectHead(headHtml: string) {
  if (typeof document === "undefined") return;
  const scriptSrc = headHtml.match(/<script[^>]+src="([^"]+)"/)?.[1];
  const linkHref = headHtml.match(/<link[^>]+href="([^"]+)"/)?.[1];
  const key = scriptSrc ?? headHtml;
  if (injectedHeads.has(key)) return;
  injectedHeads.add(key);

  if (linkHref && !document.head.querySelector(`link[href="${CSS.escape(linkHref)}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = linkHref;
    document.head.appendChild(link);
  }
  if (scriptSrc && !document.head.querySelector(`script[src="${CSS.escape(scriptSrc)}"]`)) {
    const script = document.createElement("script");
    script.type = "module";
    script.src = scriptSrc;
    document.head.appendChild(script);
  }
}

export function MarimoEmbed({ base64Body }: { base64Body: string }) {
  const payload = useMemo(() => parseEmbedPayload(base64Body), [base64Body]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!payload) return;
    try {
      injectHead(payload.headHtml);
      // Drop the island HTML into the host. The islands runtime scans the DOM for
      // <marimo-island> elements and hydrates them — so setting innerHTML is enough.
      if (hostRef.current) hostRef.current.innerHTML = payload.islandHtml;
    } catch {
      setFailed(true);
    }
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
      {/* The island mounts here (hydrated by the runtime). */}
      <div ref={hostRef} data-testid="marimo-embed-host" className="marimo-island-host" />
      {failed ? (
        <p className="px-1 text-xs text-destructive">Couldn’t render the marimo embed.</p>
      ) : null}
    </figure>
  );
}
