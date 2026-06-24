import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
import { App } from "./App.js";
import { sessionStore } from "./sessions.js";
import { loadConversations } from "./client.js";

// On load — and then on a light interval — pull every conversation from the
// agent-host so the sidebar survives a refresh, lists conversations created
// elsewhere (e.g. by a webhook), and reflects agent-assigned titles promptly.
// The agent titles a conversation early in its first reply (server-side, via the
// <title> marker); the periodic merge surfaces that without a manual refresh.
const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");
const refreshConversations = () =>
  void loadConversations({ baseUrl: BASE_URL }).then((convs) => {
    sessionStore.mergeFromServer(convs);
  });
refreshConversations();
setInterval(refreshConversations, 10000);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
