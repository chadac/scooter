import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
import { App } from "./App.js";
import { viewStore } from "./view.js";
import { currentConversation, sessionStore } from "./sessions.js";
import { loadConversations, loadConversationsResult, loadWhoami } from "./client.js";
import { subscribeConversations } from "./conversationStream.js";
import { initTelemetryFromServer, installGlobalErrorHandlers } from "./telemetry.js";

// Browser telemetry, configured at RUNTIME rather than build time: the image is built once
// and deployed to clusters that may or may not have a collector, so a VITE_* flag baked
// into the bundle could not express that. nginx serves /telemetry/config.json from the
// deployment's own env.
//
// TRADE-OFF: fetching that config is asynchronous, so fetch auto-instrumentation patches
// window.fetch a tick or two AFTER load — the very first requests of a page load are not
// traced. Accepted deliberately: those are the sidebar/whoami fetches, and the failures
// worth catching (stream reconnects, id reassignment, mid-run remounts) all happen later.
// Making them traceable would mean blocking startup on a network round-trip, which is a
// bad trade for an observability feature.
//
// The error handlers install SYNCHRONOUSLY and are not gated on telemetry being ready, so
// a throw during startup is still captured once the exporter comes up.
void initTelemetryFromServer();
installGlobalErrorHandlers();

// On load — and then on a light interval — pull every conversation from the
// agent-host so the sidebar survives a refresh, lists conversations created
// elsewhere (e.g. by a webhook), and reflects agent-assigned titles promptly.
// The agent titles a conversation early in its first reply (server-side, via the
// <title> marker); the periodic merge surfaces that without a manual refresh.
const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

// Load ALL conversations; the Mine/All toggle filters client-side by owner (we
// know the caller via /whoami), so toggling is instant + needs no refetch.
const refreshConversations = () =>
  void loadConversations({ baseUrl: BASE_URL }, "all").then((convs) => {
    sessionStore.mergeFromServer(convs);
  });

// Who am I (the ingress identity) — labels conversations "mine" + shows the
// signed-in user in the header.
void loadWhoami({ baseUrl: BASE_URL }).then((me) => sessionStore.setCurrentUser(me));

// Initial load with fast retry-and-backoff: during an agent-host restart
// (deploy / node consolidation, ~30-60s) the first fetch fails and a fresh tab
// would otherwise show an empty sidebar until the 10s poll. Retry quickly while
// the server is unreachable so the sidebar paints within a second or two of it
// coming back — then hand off to the steady poll. (A reachable-but-empty server
// is a success: stop retrying.)
const initialLoad = async () => {
  for (let delay = 500; delay <= 8000; delay *= 2) {
    const { ok, conversations } = await loadConversationsResult({ baseUrl: BASE_URL }, "all");
    if (ok) {
      sessionStore.mergeFromServer(conversations);
      return;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
};
void initialLoad();
setInterval(refreshConversations, 10000);

// Live sidebar push: subscribe to the agent-host's conversation-list stream so a
// NEW conversation (e.g. a Slack thread) — or an agent-assigned title — lands in
// the sidebar INSTANTLY instead of on the next 10s poll. We fold both frames
// through the SAME sessionStore.mergeFromServer the poll uses, so a streamed
// conversation gets its source badge/owner exactly like a polled one. Scope
// "all" MIRRORS the poll (which loads everything and filters Mine/All
// client-side via /whoami), so the stream never shows less than the poll. The
// 10s poll stays as the reconcile/backstop; the stream just makes it feel
// instant. It reconnects on drop internally. This tab lives for the page's
// lifetime, so there is no unmount to close on (parallel to the setInterval).
subscribeConversations({ baseUrl: BASE_URL }, "all", {
  onSnapshot: (list) => sessionStore.mergeFromServer(list),
  // A single-row upsert is NOT authoritative for sources/links: link changes don't fire it, so
  // its links re-read is incidental and an empty `sources: []` would clobber the poll-populated
  // provider icon. The poll + this snapshot own sources; the upsert only advances the rest of the
  // row. Why: PR #452.
  onUpsert: (c) => sessionStore.mergeFromServer([c], { sourcesAuthoritative: false }),
});

// Deep-link support (?thread=<id>). The webhooks service posts a "View
// conversation" link of the form <ui>/?thread=<id>; opening it should land on
// that conversation — even one the user has never seen (it arrives via the
// poll/stream, then requestSelect's pending target selects it). We also keep the
// URL in sync as the user switches conversations, so the address bar is always a
// shareable deep-link (and refresh restores the same conversation).
const threadParam = new URLSearchParams(globalThis.location?.search ?? "").get("thread");
if (threadParam) sessionStore.requestSelect(threadParam);

// Reflect the selected conversation in the URL (replaceState — no history spam).
// NOTE: this writes the CURRENT href back, so it must not run while the user is on a
// /settings/<tab> path — replaceState there would rewrite the settings URL (and, worse,
// pin the pathname if the conversation changes underneath). The thread param is still
// updated when they return to chat, so the deep-link stays accurate.
sessionStore.subscribe(() => {
  if (viewStore.get() === "settings") return;
  // The SERVER's id, never `currentId` — that is the LOCAL KEY. Writing it here
  // produced a `?thread=<key>` the server 404s: the stream ran against the real
  // conversation while the URL named a phantom, so a reload lost the conversation
  // entirely. Same class as #341/#347, which fixed the streaming path and missed
  // this one. Before the id arrives there is nothing to reflect — leave the URL be.
  const id = currentConversation()?.serverId();
  if (id === undefined) return;
  const url = new URL(globalThis.location.href);
  if (url.searchParams.get("thread") !== id) {
    url.searchParams.set("thread", id);
    globalThis.history.replaceState(null, "", url);
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
