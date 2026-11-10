// Web app review overlay, injected into the app's pages by the review proxy.
// Dormant unless the page is framed by the review shell. Its UI lives in a
// shadow root, so the app's CSS can't reach it and its CSS can't reach the app.
(() => {
  "use strict";
  const script = document.currentScript;
  if (!script || window.__scooterReview) return;
  window.__scooterReview = true;
  const APP_BASE = script.dataset.appBase;
  const SHELL_BASE = script.dataset.shellBase;
  const API = APP_BASE + "/__review/";

  let shell = null;
  try {
    if (window.parent !== window && window.parent.location.pathname.startsWith(SHELL_BASE)) shell = window.parent;
  } catch { /* framed by someone else */ }
  if (!shell) return;
  const tell = (msg) => shell.postMessage(msg, location.origin);

  // --- route announcements --------------------------------------------------------
  const route = () => (location.pathname.startsWith(APP_BASE) ? location.pathname.slice(APP_BASE.length) || "/" : location.pathname) + location.search + location.hash;
  const pathOf = (r) => r.split(/[?#]/)[0].replace(/(.)\/$/, "$1");
  let lastRoute = null;
  function announce() {
    const r = route();
    if (r !== lastRoute) {
      lastRoute = r;
      closePopover();
      schedule();
    }
    tell({ type: "review:route", route: r, title: document.title });
  }
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) {
      const out = orig.apply(this, args);
      queueMicrotask(announce);
      return out;
    };
  }
  addEventListener("popstate", announce);
  addEventListener("hashchange", announce);

  // --- the shadow UI --------------------------------------------------------------
  const host = document.createElement("scooter-review");
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "open" });
  // A constructed sheet, since the app's CSP may forbid <style>.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 system-ui, sans-serif; }
    /* Only text worth copying is selectable; never the hover outline or pins. */
    * { user-select: none; -webkit-user-select: none; }
    textarea, .pop .thread { user-select: text; -webkit-user-select: text; }
    .catcher { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; }
    .catcher[hidden] { display: none; }
    .hl { position: fixed; border: 2px solid #db2777; background: rgb(219 39 119 / .08); border-radius: 3px; pointer-events: none; }
    .hl[hidden] { display: none; }
    .hl .tag { position: absolute; top: -20px; left: -2px; background: #db2777; color: #fff; font: 11px ui-monospace, monospace; padding: 1px 5px; border-radius: 3px; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .pin { position: fixed; pointer-events: auto; cursor: pointer; }
    .pin.point { width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50% 50% 50% 0; background: #db2777; color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; box-shadow: 0 2px 6px rgb(0 0 0 / .3); border: 2px solid #fff; }
    .pin.area { border: 2px solid #db2777; background: rgb(219 39 119 / .06); border-radius: 4px; pointer-events: none; }
    .pin.area .num { pointer-events: auto; position: absolute; top: -11px; left: -11px; width: 22px; height: 22px; border-radius: 50%; background: #db2777; color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; border: 2px solid #fff; }
    .pin.resolved, .pin.resolved .num { background-color: #15803d; }
    .pin.area.resolved { background: none; border-color: rgb(21 128 61 / .5); border-style: dashed; }
    .pin.point.just-resolved, .pin.just-resolved .num { animation: review-pop .45s ease-out var(--since, 0s); }
    @keyframes review-pop { 0% { transform: scale(.6); } 60% { transform: scale(1.25); } 100% { transform: scale(1); } }
    .pin.detached { opacity: .55; }
    .pin.point.unread::after, .pin.unread .num::after { content: ""; position: absolute; top: -4px; right: -4px; width: 8px; height: 8px; border-radius: 50%; background: #2563eb; border: 2px solid #fff; }
    .pop { position: fixed; width: 320px; pointer-events: auto; background: Canvas; color: CanvasText; color-scheme: light dark; border: 1px solid #d4d4d8; border-radius: 10px; box-shadow: 0 12px 32px rgb(0 0 0 / .25); padding: 10px; display: grid; gap: 8px; }
    .pop textarea { width: 100%; min-height: 70px; resize: vertical; padding: 6px 8px; border: 1px solid #d4d4d8; border-radius: 6px; background: Canvas; color: CanvasText; }
    .pop .row { display: flex; gap: 6px; align-items: center; }
    .pop .row .grow { flex: 1; }
    .pop button { padding: 4px 10px; border-radius: 6px; border: 1px solid #d4d4d8; background: Canvas; color: CanvasText; cursor: pointer; }
    .pop button.primary { background: #db2777; color: #fff; border-color: #db2777; }
    .pop button:disabled { opacity: .5; cursor: default; }
    .pop .meta { color: #71717a; font-size: 11px; }
    .pop .shot { position: relative; max-height: 140px; overflow: hidden; border: 1px solid #d4d4d8; border-radius: 6px; background: repeating-conic-gradient(#8881 0 25%, transparent 0 50%) 0 0 / 12px 12px; }
    .pop .shot img { display: block; max-width: 100%; margin: 0 auto; }
    .pop .shot button { position: absolute; top: 4px; right: 4px; padding: 0 6px; }
    .pop .shot .wait { padding: 12px; color: #71717a; font-size: 12px; }
    .pop .warn { color: #a16207; font-size: 11px; }
    .pop label { font-size: 12px; display: flex; gap: 4px; align-items: center; }
    .msg { padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, CanvasText 6%, transparent); white-space: pre-wrap; }
    .msg.agent { background: color-mix(in srgb, #db2777 10%, transparent); }
    .msg .by { font-size: 11px; color: #71717a; display: block; }
    .thread { display: grid; gap: 6px; max-height: 220px; overflow: auto; }
    .pop textarea.short { min-height: 48px; }
  `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `  <div class="pins"></div>
  <div class="catcher" hidden></div>
  <div class="hl" hidden><span class="tag"></span></div>`;
  const pinsEl = root.querySelector(".pins");
  const catcher = root.querySelector(".catcher");
  const hl = root.querySelector(".hl");
  const mount = () => { if (!host.isConnected) document.documentElement.append(host); };
  new MutationObserver(mount).observe(document.documentElement, { childList: true });
  mount();

  // --- describing elements --------------------------------------------------------
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const looksGenerated = (s) => /\d{3,}|^[a-z]{1,3}-[a-z0-9]{5,}$|^(css|sc|jsx|svelte)-/i.test(s);
  // State classes come and go, so a selector naming one goes stale.
  const isState = (s) => /^(is-|has-)|^(active|selected|current|open|focus(ed)?|hover(ed)?|disabled|checked|expanded|on)$/i.test(s);
  function step(el) {
    if (el.id && !looksGenerated(el.id) && unique("#" + cssEsc(el.id))) return { sel: "#" + cssEsc(el.id), done: true };
    for (const a of ["data-testid", "data-test", "data-cy", "aria-label", "name"]) {
      const v = el.getAttribute(a);
      if (v && v.length < 60) {
        const sel = `${el.localName}[${a}="${v.replace(/"/g, '\\"')}"]`;
        if (unique(sel)) return { sel, done: true };
      }
    }
    let sel = el.localName;
    const classes = [...el.classList].filter((c) => !looksGenerated(c) && !isState(c)).slice(0, 2);
    if (classes.length) sel += "." + classes.map(cssEsc).join(".");
    const parent = el.parentElement;
    if (parent && [...parent.children].filter((c) => c.localName === el.localName).length > 1) {
      sel += `:nth-of-type(${[...parent.children].filter((c) => c.localName === el.localName).indexOf(el) + 1})`;
    }
    return { sel, done: false };
  }
  function selectorFor(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      const { sel, done } = step(e);
      parts.unshift(sel);
      if (done || (parts.length >= 2 && unique(parts.join(" > "))) || e.localName === "body") break;
    }
    return parts.join(" > ");
  }
  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  function htmlOf(el) {
    const c = el.cloneNode(true);
    let s = c.outerHTML.replace(/\s+/g, " ");
    return s.length > 1024 ? s.slice(0, 1023) + "…" : s;
  }
  const appUnder = (x, y) => document.elementsFromPoint(x, y).find((el) => el !== host && el !== document.documentElement);
  const rectOf = (el) => el.getBoundingClientRect();
  const viewport = () => ({
    w: innerWidth, h: innerHeight, scrollX, scrollY, dpr: devicePixelRatio,
    scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  });

  // --- modes ----------------------------------------------------------------------
  let mode = null, dragStart = null, hovered = null;
  function setMode(m, fromShell) {
    mode = m;
    catcher.hidden = !mode;
    catcher.style.cursor = mode === "area" ? "crosshair" : "default";
    hl.hidden = true;
    hovered = null;
    if (!fromShell) tell({ type: "review:mode", mode });
  }
  function showBox(r, label) {
    hl.hidden = false;
    Object.assign(hl.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    hl.firstElementChild.textContent = label || "";
    hl.firstElementChild.hidden = !label;
  }
  catcher.addEventListener("pointermove", (e) => {
    if (mode === "point") {
      const el = appUnder(e.clientX, e.clientY);
      if (el && el !== hovered) {
        hovered = el;
        const label = step(el).sel;
        showBox(rectOf(el), label);
      }
    } else if (mode === "area" && dragStart) {
      const x = Math.min(dragStart.x, e.clientX), y = Math.min(dragStart.y, e.clientY);
      showBox({ left: x, top: y, width: Math.abs(e.clientX - dragStart.x), height: Math.abs(e.clientY - dragStart.y) });
    }
  });
  catcher.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (mode === "area") {
      catcher.setPointerCapture(e.pointerId);
      dragStart = { x: e.clientX, y: e.clientY };
    }
  });
  catcher.addEventListener("pointerup", (e) => {
    if (mode === "point") {
      const el = appUnder(e.clientX, e.clientY);
      if (!el) return;
      const r = rectOf(el);
      startNote({ kind: "point", el, rel: { x: e.clientX - r.left, y: e.clientY - r.top, w: 0, h: 0 } });
    } else if (mode === "area" && dragStart) {
      const box = { left: Math.min(dragStart.x, e.clientX), top: Math.min(dragStart.y, e.clientY), width: Math.abs(e.clientX - dragStart.x), height: Math.abs(e.clientY - dragStart.y) };
      dragStart = null;
      if (box.width < 8 || box.height < 8) { hl.hidden = true; return; }
      startArea(box);
    }
  });
  catcher.addEventListener("wheel", (e) => scrollBy(e.deltaX, e.deltaY), { passive: true });

  const contains = (outer, inner) => outer.left <= inner.left + 1 && outer.top <= inner.top + 1 &&
    outer.right >= inner.left + inner.width - 1 && outer.bottom >= inner.top + inner.height - 1;
  function startArea(box) {
    let el = appUnder(box.left + box.width / 2, box.top + box.height / 2) || document.body;
    while (el.parentElement && el !== document.body && !contains(rectOf(el), box)) el = el.parentElement;
    const cr = rectOf(el);
    const overlaps = [];
    for (const c of el.querySelectorAll("*")) {
      if (overlaps.length >= 10) break;
      const r = rectOf(c);
      const hit = r.width && r.height && r.left < box.left + box.width && r.right > box.left && r.top < box.top + box.height && r.bottom > box.top;
      const leafy = c.children.length === 0 || /^(a|button|input|select|textarea|img|canvas|svg|label|h[1-6]|td|th|li)$/.test(c.localName);
      if (hit && leafy && !overlaps.some((o) => o.el.contains(c))) overlaps.push({ el: c });
    }
    startNote({
      kind: "area", el, box,
      rel: { x: box.left - cr.left, y: box.top - cr.top, w: box.width, h: box.height },
      overlaps: overlaps.map(({ el: o }) => ({ selector: selectorFor(o), text: textOf(o).slice(0, 60) })),
    });
  }

  // --- screenshots ----------------------------------------------------------------
  let lib = null;
  function loadLib() {
    lib ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = API + "vendor/modern-screenshot.js";
      s.onload = () => (window.modernScreenshot ? resolve(window.modernScreenshot) : reject(new Error("screenshot library missing")));
      s.onerror = () => reject(new Error("screenshot library unavailable"));
      document.head.append(s);
    });
    return lib;
  }
  // Why a DOM capture of this region may be incomplete.
  function blindSpots(region) {
    const out = [];
    const inRegion = (el) => { const r = rectOf(el); return r.right > region.left && r.left < region.right && r.bottom > region.top && r.top < region.bottom; };
    const cross = [...document.images].filter((i) => inRegion(i) && !i.crossOrigin && /^https?:/.test(i.currentSrc || i.src) && new URL(i.currentSrc || i.src).origin !== location.origin).length;
    if (cross) out.push(`${cross} cross-origin image${cross > 1 ? "s" : ""}`);
    let tainted = 0;
    for (const c of document.querySelectorAll("canvas")) {
      if (!inRegion(c)) continue;
      try { c.toDataURL(); } catch { tainted++; }
    }
    if (tainted) out.push(`${tainted} tainted canvas`);
    const n = [...document.querySelectorAll("iframe, video, embed, object")].filter(inRegion).length;
    if (n) out.push(`${n} iframe/video`);
    return out.join(", ");
  }
  const pageBg = () => {
    for (const el of [document.body, document.documentElement]) {
      const c = el && getComputedStyle(el).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "#111" : "#fff";
  };
  // Captures a viewport rect, outlining `mark` (client coordinates).
  async function capture(region, mark) {
    const ms = await loadLib();
    const scale = Math.min(devicePixelRatio || 1, 2);
    // <body>: capturing <html> loses stylesheet styles.
    const body = document.body;
    const b = body.getBoundingClientRect();
    const opts = {
      scale, backgroundColor: pageBg(), filter: (n) => n !== host,
      width: Math.max(body.scrollWidth, b.width), height: Math.max(body.scrollHeight, b.height),
      // The clone is the image root; margin would shift it.
      style: { margin: "0" },
    };
    // A started preload="none" video's clone never loads; capture hangs.
    const lazy = [...document.querySelectorAll("video[preload=none]")].filter((v) => v.currentSrc);
    lazy.forEach((v) => (v.preload = "auto"));
    // Embedding fonts needs a <style>, which strict CSPs block.
    const shot = ms.domToCanvas(body, opts).catch(() => ms.domToCanvas(body, { ...opts, font: false }));
    // Never let one stuck resource block saving the note.
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 15000));
    const full = await Promise.race([shot, late]).finally(() => lazy.forEach((v) => (v.preload = "none")));
    const sx = (region.left - b.left) * scale, sy = (region.top - b.top) * scale;
    let w = region.width * scale, h = region.height * scale;
    const fit = Math.min(1, 1600 / w);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w * fit));
    out.height = Math.max(1, Math.round(h * fit));
    const g = out.getContext("2d");
    g.drawImage(full, sx, sy, w, h, 0, 0, out.width, out.height);
    if (mark) {
      g.strokeStyle = "#db2777";
      g.lineWidth = 3;
      const k = scale * fit;
      g.strokeRect((mark.left - region.left) * k - 1.5, (mark.top - region.top) * k - 1.5, mark.width * k + 3, mark.height * k + 3);
    }
    return out.toDataURL("image/png");
  }
  function around(r, margin) {
    const left = Math.max(0, r.left - margin), top = Math.max(0, r.top - margin);
    const right = Math.min(innerWidth, r.left + r.width + margin), bottom = Math.min(innerHeight, r.top + r.height + margin);
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top), right, bottom };
  }
  let exactSeq = 0;
  const exactWaits = new Map();
  function exactCapture(region) {
    const id = ++exactSeq;
    return new Promise((resolve, reject) => {
      exactWaits.set(id, { resolve, reject });
      tell({ type: "review:exact", id, rect: { x: region.left, y: region.top, w: region.width, h: region.height } });
    });
  }

  // --- composing a note -----------------------------------------------------------
  let pop = null;
  function closePopover() {
    if (pop) pop.remove();
    pop = null;
  }
  function place(el, r) {
    const w = 320, gap = 10;
    let left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    let top = r.top + r.height + gap;
    el.style.left = left + "px";
    el.style.top = top + "px";
    requestAnimationFrame(() => {
      const h = el.offsetHeight;
      if (top + h > innerHeight - 8) el.style.top = Math.max(8, r.top - h - gap) + "px";
    });
  }
  function startNote(n) {
    const target = n.kind === "area" ? n.box : rectOf(n.el);
    const markRect = { left: target.left, top: target.top, width: target.width, height: target.height };
    setMode(null);
    showBox(markRect, "");
    closePopover();
    pop = document.createElement("div");
    pop.className = "pop";
    pop.innerHTML = `
      <div class="meta"></div>
      <textarea placeholder="What should change here?"></textarea>
      <div class="shot"><div class="wait">Taking a screenshot…</div></div>
      <div class="warn" hidden></div>
      <div class="row">
        <label class="grow" title="Use the browser's screen capture: exact pixels, asks permission"><input type="checkbox" class="exact"> Pixel-exact</label>
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="primary save">Save</button>
      </div>`;
    pop.querySelector(".meta").textContent = n.kind === "area" ? `Area in ${step(n.el).sel}` : step(n.el).sel;
    if (!(shell.navigator.mediaDevices && shell.navigator.mediaDevices.getDisplayMedia)) pop.querySelector(".exact").parentElement.style.visibility = "hidden";
    root.append(pop);
    place(pop, markRect);
    const ta = pop.querySelector("textarea");
    ta.focus();

    const region = around(markRect, 24);
    const warning = blindSpots(region);
    let shot = null;
    const shotEl = pop.querySelector(".shot");
    const showShot = (url) => {
      shot = url;
      shotEl.innerHTML = `<img alt="Screenshot"><button type="button" title="Don't attach">✕</button>`;
      shotEl.querySelector("img").src = url;
      shotEl.querySelector("button").onclick = () => { shot = null; shotEl.hidden = true; };
    };
    // The overlay's highlight must not be in the picture.
    hl.hidden = true;
    const shooting = capture(region, markRect).then(showShot, (err) => {
      shotEl.innerHTML = `<div class="wait">No screenshot: ${String(err.message || err)}</div>`;
    }).finally(() => { if (pop) showBox(markRect, ""); });
    if (warning) {
      const w = pop.querySelector(".warn");
      w.hidden = false;
      w.textContent = `May be incomplete: ${warning}`;
    }

    const cancel = () => { closePopover(); hl.hidden = true; };
    const save = async () => {
      const comment = ta.value.trim();
      if (!comment) return ta.focus();
      const btn = pop.querySelector(".save");
      btn.disabled = true;
      let attached = shot, shotWarning = warning;
      try {
        if (pop.querySelector(".exact").checked) {
          pop.style.visibility = "hidden";
          hl.hidden = true;
          attached = await exactCapture(region);
          shotWarning = "";
        } else {
          await shooting;
          attached = shot;
        }
      } catch (err) {
        pop.style.visibility = "";
        btn.disabled = false;
        pop.querySelector(".warn").hidden = false;
        pop.querySelector(".warn").textContent = "Pixel-exact capture failed: " + (err.message || err);
        return;
      }
      const doc = { x: target.left + scrollX, y: target.top + scrollY, w: target.width, h: target.height };
      const body = {
        kind: n.kind, route: route(), title: document.title,
        anchor: { selector: selectorFor(n.el), text: textOf(n.el) },
        html: n.kind === "point" ? htmlOf(n.el) : "",
        rel: n.rel, doc, overlaps: n.overlaps || [], viewport: viewport(),
        comment, shot: attached || "", shotWarning: attached ? shotWarning : "",
      };
      try {
        await api("notes", body);
        cancel();
      } catch (err) {
        btn.disabled = false;
        pop.style.visibility = "";
        pop.querySelector(".warn").hidden = false;
        pop.querySelector(".warn").textContent = "Not saved: " + (err.message || err);
      }
    };
    pop.querySelector(".cancel").onclick = cancel;
    pop.querySelector(".save").onclick = save;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
      e.stopPropagation();
    });
  }

  // --- pins and threads -----------------------------------------------------------
  let state = { notes: [] }, hidePins = false;
  // When each note turned resolved here, so only that change animates.
  const resolvedAt = new Map();
  // Scooter changed the note since the user last opened it.
  const isUnread = (n) => !!n.agentAt && (!n.readAt || Date.parse(n.agentAt) > Date.parse(n.readAt));
  let loaded = false;
  function anchorRect(n) {
    let el = null;
    try { el = document.querySelector(n.anchor.selector); } catch { /* bad selector */ }
    if (el) {
      const r = rectOf(el);
      if (r.width || r.height) return { r, detached: false };
    }
    return { r: { left: n.doc.x - scrollX - n.rel.x, top: n.doc.y - scrollY - n.rel.y }, detached: true };
  }
  function draw() {
    pinsEl.replaceChildren();
    if (hidePins) return;
    const here = pathOf(route());
    for (const n of state.notes) {
      if (n.hidden || pathOf(n.route) !== here) continue;
      const { r, detached } = anchorRect(n);
      const pin = document.createElement("div");
      const since = performance.now() - (resolvedAt.get(n.id) ?? -1e9);
      const just = since < 450;
      pin.className = `pin ${n.kind}${n.resolved ? " resolved" : ""}${just ? " just-resolved" : ""}${isUnread(n) ? " unread" : ""}${detached ? " detached" : ""}`;
      const label = n.resolved ? "✓" : String(n.num);
      pin.dataset.id = n.id;
      pin.title = (detached ? "(element not found) " : "") + (n.resolved ? "Resolved: " : "") + (n.thread[0]?.text ?? "");
      // Redraws recreate pins; a negative delay resumes the animation.
      if (just) pin.style.setProperty("--since", `-${since}ms`);
      if (n.kind === "area") {
        Object.assign(pin.style, { left: r.left + n.rel.x + "px", top: r.top + n.rel.y + "px", width: n.rel.w + "px", height: n.rel.h + "px" });
        pin.innerHTML = `<span class="num">${label}</span>`;
        pin.firstChild.onclick = () => openThread(n.id);
      } else {
        Object.assign(pin.style, { left: r.left + n.rel.x + "px", top: r.top + n.rel.y + "px" });
        pin.textContent = label;
        pin.onclick = () => openThread(n.id);
      }
      pinsEl.append(pin);
    }
    if (pop && pop.dataset.thread) {
      const n = state.notes.find((x) => x.id === pop.dataset.thread);
      const pin = pinsEl.querySelector(`[data-id="${pop.dataset.thread}"]`);
      if (n && pin) place(pop, pin.getBoundingClientRect());
    }
  }
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  }
  addEventListener("scroll", schedule, { passive: true, capture: true });
  addEventListener("resize", schedule);
  setInterval(() => { if (state.notes.length) schedule(); }, 300);

  function openThread(id) {
    const n = state.notes.find((x) => x.id === id);
    if (!n) return;
    closePopover();
    pop = document.createElement("div");
    pop.className = "pop";
    pop.dataset.thread = String(id);
    if (isUnread(n)) api(`notes/${id}/read`, {}).catch(() => {});
    const status = n.resolved ? "resolved" : "open";
    pop.innerHTML = `
      <div class="row"><b class="grow">#${n.num} · ${n.kind}</b><span class="meta">${status}</span></div>
      <div class="thread"></div>
      <textarea class="short" placeholder="Reply…"></textarea>
      <div class="row">
        <button type="button" class="del" title="Delete this note">Delete</button>
        <button type="button" class="hide" title="Hide this pin; the Pins list keeps it">Hide</button>
        <span class="grow"></span>
        <button type="button" class="res">${n.resolved ? "Reopen" : "Resolve"}</button>
        <button type="button" class="primary reply">Reply</button>
      </div>`;
    const thread = pop.querySelector(".thread");
    for (const m of n.thread) {
      const d = document.createElement("div");
      d.className = "msg " + m.by;
      d.innerHTML = `<span class="by"></span>`;
      d.firstChild.textContent = m.by === "agent" ? "Scooter" : "You";
      d.append(m.text);
      thread.append(d);
    }
    root.append(pop);
    const pin = pinsEl.querySelector(`[data-id="${id}"]`);
    place(pop, pin ? pin.getBoundingClientRect() : { left: 40, top: 40, width: 0, height: 0 });
    const ta = pop.querySelector("textarea");
    const reply = async () => {
      const text = ta.value.trim();
      if (!text) return;
      // Clear first: the reply's own update redraws the thread mid-request.
      ta.value = "";
      try {
        await api(`notes/${id}/reply`, { text });
      } catch (err) {
        const box = pop && pop.dataset.thread === id && pop.querySelector("textarea");
        if (box && !box.value) box.value = text;
        throw err;
      }
    };
    pop.querySelector(".reply").onclick = reply;
    pop.querySelector(".res").onclick = () => api(`notes/${id}/resolve`, { resolved: !n.resolved }).then(closePopover);
    pop.querySelector(".hide").onclick = () => api("hide", { ids: [id], hidden: true }).then(closePopover);
    pop.querySelector(".del").onclick = () => api(`notes/${id}`, undefined, "DELETE").then(closePopover);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePopover();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) reply();
      e.stopPropagation();
    });
  }
  // A popover closes on a click elsewhere in the app.
  addEventListener("pointerdown", (e) => { if (pop && pop.dataset.thread && !e.composedPath().includes(host)) closePopover(); }, true);

  async function api(path, body, method) {
    const r = await fetch(API + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  }

  // --- live state and snap requests -----------------------------------------------
  function connect() {
    const es = new EventSource(API + "events?role=overlay");
    es.addEventListener("notes", (e) => {
      const was = new Set(state.notes.filter((n) => n.resolved).map((n) => n.id));
      state = JSON.parse(e.data);
      for (const n of state.notes) if (n.resolved && !was.has(n.id) && loaded) resolvedAt.set(n.id, performance.now());
      loaded = true;
      draw();
      if (pop && pop.dataset.thread) {
        const id = pop.dataset.thread;
        const n = state.notes.find((x) => x.id === id);
        const typed = pop.querySelector("textarea").value;
        if (n) { openThread(id); pop.querySelector("textarea").value = typed; } else closePopover();
      }
    });
    es.addEventListener("snap", async (e) => {
      const { id } = JSON.parse(e.data);
      // Background tabs wait, so a visible page answers first.
      if (document.visibilityState !== "visible") await new Promise((r) => setTimeout(r, 1500));
      try {
        const shot = await capture(around({ left: 0, top: 0, width: innerWidth, height: innerHeight }, 0), null);
        await api("snaps/" + id, { shot });
      } catch { /* another page answered, or capture failed */ }
    });
    es.onerror = () => { es.close(); setTimeout(connect, 2000); };
  }
  connect();

  // --- the shell's commands ---------------------------------------------------------
  addEventListener("message", (e) => {
    if (e.source !== shell || e.origin !== location.origin || !e.data) return;
    const m = e.data;
    if (m.type === "review:mode") setMode(m.mode, true);
    else if (m.type === "review:hide") { hidePins = !!m.hide; draw(); }
    else if (m.type === "review:escape") closePopover();
    else if (m.type === "review:open") {
      const go = () => {
        const pin = pinsEl.querySelector(`[data-id="${m.id}"]`);
        if (pin) {
          const r = pin.getBoundingClientRect();
          if (r.top < 0 || r.bottom > innerHeight) scrollBy({ top: r.top - innerHeight / 3 });
        }
        requestAnimationFrame(() => { draw(); openThread(m.id); });
      };
      if (pathOf(m.route) !== pathOf(route())) {
        history.pushState(null, "", APP_BASE + m.route);
        dispatchEvent(new PopStateEvent("popstate", { state: null }));
        setTimeout(go, 400);
      } else go();
    } else if (m.type === "review:exact-result") {
      const w = exactWaits.get(m.id);
      exactWaits.delete(m.id);
      if (w) (m.error ? w.reject(new Error(m.error)) : w.resolve(m.shot));
    }
  });
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.composedPath().includes(host)) return;
    const t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
    const key = e.key.toLowerCase();
    if (key === "escape" && pop) { closePopover(); return; }
    if (key === "escape" && mode) { setMode(null); hl.hidden = true; return; }
    if (key === "c" || key === "r" || key === "h" || key === "p") tell({ type: "review:key", key });
  }, true);

  const titleObs = new MutationObserver(() => tell({ type: "review:route", route: route(), title: document.title }));
  const watchTitle = () => { const t = document.querySelector("title"); if (t) titleObs.observe(t, { childList: true, characterData: true, subtree: true }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { mount(); watchTitle(); announce(); });
  else { watchTitle(); announce(); }
})();
