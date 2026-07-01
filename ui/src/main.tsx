import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
import { App } from "./App.js";
import { sessionStore } from "./sessions.js";
import { loadConversations, loadConversationsResult, loadWhoami } from "./client.js";
import { subscribeConversations } from "./conversationStream.js";

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

// Who am I (the ingress identity) — used to label conversations "mine".
void loadWhoami({ baseUrl: BASE_URL }).then((me) => sessionStore.setCurrentUser(me.id));

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
  onUpsert: (c) => sessionStore.mergeFromServer([c]),
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
sessionStore.subscribe(() => {
  const id = sessionStore.get().currentId;
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
