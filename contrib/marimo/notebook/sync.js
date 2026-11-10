// marimo + chat: mirrors marimo's route, title and icon.
"use strict";
{
  const icon = document.querySelector("link[rel~=icon]");

  const sync = () => {
    let loc;
    try { loc = frame.contentWindow.location; } catch { return; } // not marimo any more
    if (loc.origin !== APP.origin || loc.pathname !== APP.pathname) return;
    page.full.href = loc.href;
    const next = location.pathname + loc.search + loc.hash;
    // replaceState only: the frame's own pushes already make the Back entries.
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, "", next);
  };
  const syncHead = () => {
    try {
      const doc = frame.contentDocument;
      document.title = doc.title || "marimo";
      const theirs = doc.querySelector("link[rel~=icon]");
      if (theirs && theirs.href) icon.href = theirs.href;
    } catch { /* cross-origin */ }
  };
  frame.addEventListener("load", () => {
    try {
      const w = frame.contentWindow;
      for (const m of ["pushState", "replaceState"]) {
        const orig = w.history[m].bind(w.history);
        w.history[m] = (...args) => { const r = orig(...args); sync(); return r; };
      }
      w.addEventListener("popstate", sync);
      // marimo opens notebooks in new tabs; keep them in this frame instead.
      const asMarimo = (href) => {
        const u = new URL(href, w.location.href);
        return u.origin === APP.origin && u.pathname === APP.pathname ? u : null;
      };
      const origOpen = w.open.bind(w);
      w.open = (url, target, features) => {
        const u = url ? asMarimo(String(url)) : null;
        if (!u) return origOpen(url, target, features);
        w.location.assign(u.href);
        return w;
      };
      const onLink = (e) => {
        const a = e.target.closest && e.target.closest("a[href]");
        const u = a && asMarimo(a.href);
        if (!u) return;
        // An explicit new-tab gesture still opens this page, with its chat.
        if (e.type === "auxclick" || e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          window.open(location.pathname + u.search + u.hash, "_blank");
          return;
        }
        if ((a.target || "_self").toLowerCase() === "_self") return;
        e.preventDefault();
        w.location.assign(u.href);
      };
      w.document.addEventListener("click", onLink, true);
      w.document.addEventListener("auxclick", (e) => { if (e.button === 1) onLink(e); }, true);
      w.addEventListener("hashchange", sync);
      new MutationObserver(syncHead).observe(w.document.head, { subtree: true, childList: true, characterData: true, attributes: true });
    } catch { /* cross-origin: nothing to follow */ }
    sync();
    syncHead();
  });
}
