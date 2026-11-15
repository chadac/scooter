// This conversation in marimo's Agent panel, open and connected on load. Runs before
// marimo's bundle (launch.py puts it in the page head, with SCOOTER_ACP_PATH set first).
"use strict";
(() => {
  const path = window.SCOOTER_ACP_PATH;
  const Native = window.WebSocket;
  if (!path || !Native) return;

  // marimo's saved UI state, seeded before it loads: the AI panel open on Agents, once,
  // so a user who closes it keeps it closed; and a "claude" session, which the panel
  // connects as soon as it mounts.
  try {
    const store = window.localStorage;
    const read = (k) => { try { return JSON.parse(store.getItem(k)); } catch { return null; } };
    if (!store.getItem("scooter:agent-panel-opened")) {
      store.setItem("scooter:agent-panel-opened", "1");
      store.setItem("marimo:sidebar", JSON.stringify({ ...read("marimo:sidebar"), selectedPanel: "ai", isSidebarOpen: true }));
      store.setItem("marimo:chrome:ai-panel-tab", JSON.stringify("agents"));
    }
    const state = read("marimo:acp:sessions:v1") ?? { sessions: [], activeTabId: null };
    if (!state.sessions?.some((s) => s.agentId === "claude")) {
      const now = Date.now();
      const tabId = `scooter-${now}`;
      state.sessions = [{ tabId, agentId: "claude", title: "Scooter", createdAt: now, lastUsedAt: now, externalAgentSessionId: null, selectedModel: null }];
      state.activeTabId = tabId;
      store.setItem("marimo:acp:sessions:v1", JSON.stringify(state));
    }
  } catch {
    // No storage (private mode): the panel still works, opened by hand.
  }

  // The panel's "Claude" agent dials ws(s)://<page host>:3017/message, a port the sandbox
  // doesn't serve; that one socket opens on the conversation's ACP endpoint instead.
  const target = () => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
  const isClaudeSlot = (url) => {
    try {
      const u = new URL(String(url), location.href);
      return u.hostname === location.hostname && u.port === "3017" && u.pathname === "/message";
    } catch {
      return false;
    }
  };
  function ScooterWebSocket(url, protocols) {
    const to = isClaudeSlot(url) ? target() : url;
    return protocols === undefined ? new Native(to) : new Native(to, protocols);
  }
  ScooterWebSocket.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) ScooterWebSocket[k] = Native[k];
  window.WebSocket = ScooterWebSocket;
})();
