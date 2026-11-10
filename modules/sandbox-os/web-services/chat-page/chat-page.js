// ChatPage.mount(appPane, cfg): chat and rail left of appPane; see README.
"use strict";
window.ChatPage = {
  mount(appPane, cfg) {
    const el = (tag, props) => Object.assign(document.createElement(tag), props);
    const layout = el("div", { id: "layout" });
    const chat = el("div", { id: "chat" });
    const rail = el("div", { id: "rail", title: "Drag to resize the chat" });
    const toggle = el("button", { id: "toggle", type: "button" });
    const conv = el("a", {
      id: "conv", href: cfg.convUrl || "", hidden: !cfg.convUrl, target: "_blank", rel: "noopener",
      title: "Open in Scooter", textContent: "🛴",
    });
    const full = cfg.full || {};
    const fullLink = el("a", {
      id: "full", href: full.href || "", target: full.target || "_blank", title: full.title || "Open the app on its own",
      textContent: "⤢",
    });
    if (fullLink.target === "_blank") fullLink.rel = "noopener";
    for (const a of [conv, fullLink]) a.ariaLabel = a.title;
    rail.append(toggle, conv, fullLink);
    appPane.replaceWith(layout);
    appPane.classList.add("chat-page-app");
    layout.append(chat, rail, appPane);

    if (cfg.chatUrl) {
      chat.append(el("iframe", { title: "Scooter chat", src: cfg.chatUrl, allow: "clipboard-read; clipboard-write" }));
    } else {
      chat.append(el("p", { id: "missing", textContent: "No chat URL: this sandbox has no CONVERSATION_URL." }));
    }

    const KEY_W = `scooter.${cfg.storageKey}.chatWidth`, KEY_C = `scooter.${cfg.storageKey}.chatCollapsed`;
    const minApp = cfg.minApp || 320;
    const clamp = (w) => Math.max(260, Math.min(w, window.innerWidth - minApp));
    const setWidth = (w) => layout.style.setProperty("--chat-width", clamp(w) + "px");
    const setCollapsed = (c) => {
      layout.classList.toggle("collapsed", c);
      toggle.textContent = c ? "›" : "‹";
      toggle.title = toggle.ariaLabel = c ? "Show chat" : "Hide chat";
      localStorage.setItem(KEY_C, c ? "1" : "0");
    };
    setWidth(Number(localStorage.getItem(KEY_W)) || 420);
    setCollapsed(localStorage.getItem(KEY_C) === "1");

    toggle.addEventListener("click", () => setCollapsed(!layout.classList.contains("collapsed")));
    rail.addEventListener("pointerdown", (e) => {
      if (e.target !== rail || layout.classList.contains("collapsed")) return;
      rail.setPointerCapture(e.pointerId);
      layout.classList.add("dragging");
    });
    rail.addEventListener("pointermove", (e) => {
      if (layout.classList.contains("dragging")) setWidth(e.clientX - chat.getBoundingClientRect().left);
    });
    const endDrag = () => {
      if (!layout.classList.contains("dragging")) return;
      layout.classList.remove("dragging");
      localStorage.setItem(KEY_W, String(parseInt(getComputedStyle(chat).width, 10)));
    };
    rail.addEventListener("pointerup", endDrag);
    rail.addEventListener("pointercancel", endDrag);

    return { layout, chat, rail, full: fullLink };
  },
};
