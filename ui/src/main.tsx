import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
import { App } from "./App.js";
import { sessionStore } from "./sessions.js";
import { loadConversations } from "./client.js";

// On load, pull every conversation from the agent-host so the sidebar survives a
// page refresh and all conversations are listed/searchable (not just the ones
// created in this tab). Same-origin: the API is reverse-proxied at /conversations.
const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");
void loadConversations({ baseUrl: BASE_URL }).then((convs) => {
  sessionStore.mergeFromServer(convs);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
