import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
// Side-effect import: paint the cached theme before the app mounts.
import { themeStore } from "./theme.js";
import { App } from "./App.js";
import { viewStore } from "./view.js";
import { currentConversation, sessionStore } from "./sessions.js";
import { loadThemes, loadUserTheme, loadWhoami, saveUserTheme } from "./client.js";
import { setUploadLimits } from "./fileUpload.js";
import { setSessionSeeds } from "./sessionSeeds.js";
import { subscribeConversations } from "./conversationStream.js";
import { conversationCache } from "./conversationCache.js";
import { folderStore } from "./folders.js";
import { contribEvents } from "./contribEvents.js";
import { initTelemetryFromServer, installGlobalErrorHandlers } from "./telemetry.js";
import { loadContribManifest } from "./contribManifest.js";
import { loadContribSyntax } from "./contribSyntax.js";
import { installTitleSync } from "./pageTitle.js";
import { chatRouteId } from "./chatRoute.js";
import { ChatPage, chatListStatus } from "./ChatPage.js";
import { installChunkRecovery, pageBuild, watchForUpdates } from "./appUpdate.js";

// Telemetry is configured at runtime from nginx's /telemetry/config.json, so the first
// requests of a page load go untraced while that fetch is in flight; the error handlers
// install synchronously and are not gated on it.
void initTelemetryFromServer();
installGlobalErrorHandlers();

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

const build = pageBuild();
const updates = build ? watchForUpdates({ current: build }) : undefined;
if (updates) installChunkRecovery(updates.check);

// `/chat/<id>` is the conversation subpage (chatRoute.ts): pinned to that one conversation, with
// links opening in a new tab so they never navigate a host page's iframe.
const chatId = chatRouteId(globalThis.location?.pathname ?? "/");
if (chatId) {
  sessionStore.pin(chatId);
  const base = document.createElement("base");
  base.target = "_blank";
  document.head.append(base);
}

// The ingress identity: labels conversations "mine" and names the signed-in user in
// the header.
void loadWhoami({ baseUrl: BASE_URL }).then((me) => {
  sessionStore.setCurrentUser(me);
  void conversationCache.setUser(me.id);
  // The upload caps come from the deployment (scooter.uploads), not the image.
  setUploadLimits(me.limits);
  folderStore.setDefaultLifetime(me.retention?.defaultLifetimeHours);
  setSessionSeeds(me.sessionSeeds);
});

// The account's choice wins; this browser's seeds an unset one.
void Promise.all([loadThemes({ baseUrl: BASE_URL }), loadUserTheme({ baseUrl: BASE_URL })]).then(([themes, saved]) => {
  // On failure keep the cached paint, not the built-in.
  if (themes) themeStore.setThemes(themes);
  if (!saved.configurable) return;
  const save = (choice: Parameters<typeof saveUserTheme>[1]) =>
    void saveUserTheme({ baseUrl: BASE_URL }, choice).catch((e) => console.warn("[theme] save failed:", e));
  if (saved.themeId) themeStore.adopt(saved);
  else save({ themeId: themeStore.get().themeId, mode: themeStore.get().mode });
  themeStore.onChange(save);
});

// The conversation list has exactly one source: the stream's `snapshot` on connect, then its
// upsert/remove frames. There is no periodic GET /conversations behind it — a tab opened
// during an agent-host restart paints when the stream connects (it retries until it does),
// and every divergence is repaired by a reconnect, which re-snapshots. Why: PR #780.
// Scope "all"; the Mine/All toggle filters client-side by owner, so it needs no refetch.
subscribeConversations({ baseUrl: BASE_URL }, "all", {
  onSnapshot: (list) => {
    sessionStore.mergeFromServer(list);
    // A UI deploy restarts nginx, so reconnects follow deploys.
    void updates?.check();
    // A reconnect may have missed folder and contrib frames.
    void folderStore.load();
    contribEvents.emitAll();
    chatListStatus.markLoaded();
  },
  // An upsert carries the row's whole link set, re-read when it was pushed, so it owns its own
  // sources/links — but it says nothing about any other row, so it cannot prune. Why: PR #779.
  onUpsert: (c) => sessionStore.mergeFromServer([c], { fullList: false }),
  onRemove: (id) => {
    sessionStore.removeFromServer(id);
    void conversationCache.remove(id);
  },
  onFolders: () => void folderStore.load(),
  onContrib: (contrib, ids) => contribEvents.emit(contrib, ids),
});

// Deep-link support (?thread=<id>): requestSelect's pending target selects the
// conversation once the stream delivers it.
const threadParam = new URLSearchParams(globalThis.location?.search ?? "").get("thread");
if (chatId) {
  // Pinned above; the subpage ignores ?thread= and has no fresh conversation to start.
} else if (threadParam) sessionStore.requestSelect(threadParam);
else if (viewStore.get() === "chat") sessionStore.startFresh();

installTitleSync();

// Reflect the selected conversation in the URL via replaceState, but only on the chat
// view, so a settings or contrib page URL is left alone.
sessionStore.subscribe(() => {
  if (chatId || viewStore.get() !== "chat") return;
  // Reflect the server's id, never the local key `currentId`, which the server would
  // 404; before it arrives there is nothing to reflect.
  const id = currentConversation()?.serverId();
  if (id === undefined) return;
  const url = new URL(globalThis.location.href);
  if (url.searchParams.get("thread") !== id) {
    url.searchParams.set("thread", id);
    globalThis.history.replaceState(null, "", url);
  }
});

// The contrib manifest decides what renders (labels, icons, filter chips), so the first
// paint waits for it; the loader's 1.5s timeout degrades a missing manifest to the
// built-in sources rather than a blank page. Syntax modules load next: they change parsing.
void loadContribManifest().then(loadContribSyntax).then(() => {
  // A contrib view's path is only known once the manifest names it.
  viewStore.syncFromUrl();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {chatId ? <ChatPage conversationId={chatId} /> : <App />}
    </StrictMode>,
  );
});
