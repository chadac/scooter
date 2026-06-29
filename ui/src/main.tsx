import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
import { App } from "./App.js";
import { sessionStore } from "./sessions.js";
import { loadConversations, loadConversationsResult, loadWhoami } from "./client.js";

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
