import { useEffect, useState } from "react";
import { rawUrl } from "./api";
import { isExternal, resolveRel } from "./nav";

/** An HTML file, rendered in a frame that can't reach the viewer. */
export function HtmlPane({ path, body }: { path: string; body: string }) {
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    frameDoc(path, body).then((d) => live && setDoc(d));
    return () => {
      live = false;
    };
  }, [path, body]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {doc !== null && (
        <iframe
          title={path.split("/").pop()}
          // No allow-same-origin: an opaque origin, cut off from the viewer.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={doc}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
      <p className="shrink-0 border-t border-border px-3 py-1 font-sans text-xs text-muted-foreground">
        Sandboxed preview: scripts run, but relative CSS and JS don't load.
      </p>
    </div>
  );
}

// Scripts and CDN assets load; nothing may send data back out.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

const dataUrlOf = (blob: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });

/** The document as the frame gets it: CSP first, workspace images inlined. */
async function frameDoc(path: string, body: string): Promise<string> {
  const doc = new DOMParser().parseFromString(body, "text/html");
  const meta = doc.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = CSP;
  doc.head.prepend(meta);
  // The opaque-origin frame can't send the viewer's cookie, so inline here.
  await Promise.all(
    [...doc.querySelectorAll("img[src]")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || isExternal(src)) return;
      const r = await fetch(rawUrl(src.startsWith("/") ? src : resolveRel(path, src))).catch(() => null);
      if (r?.ok) img.setAttribute("src", await dataUrlOf(await r.blob()));
    }),
  );
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
