/**
 * The conversation subpage, `/chat/<id>` (chatRoute.ts): one conversation's thread, composer and
 * pending approvals under a thin header, with no sidebar and no right panel. Embedded beside a
 * sandbox's own service (the marimo wrapper) and opened by the main header's "Pop out chat".
 * A framing page can ask for compact density with `?density=compact` (density.ts).
 *
 * The page renders the thread only once the server has listed the pinned conversation and it is
 * selected; until then the composer stays hidden, because a send against the placeholder
 * conversation would create a new one. A list that arrives without it means the caller can't
 * see it (or it doesn't exist), which the page says rather than showing an empty thread.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, Rows4 } from "lucide-react";

import { RuntimeProvider, useConversationInterrupts } from "./RuntimeProvider.js";
import { ConversationArea } from "./App.js";
import { InterruptList } from "./InterruptPanel.js";
import { ThemePicker } from "./ThemePicker.js";
import { serverKeyOf, sessionStore, useCurrentUser, useSessions } from "./sessions.js";
import { canStartSession, familyOf } from "./family.js";
import { ChatSwitcher, stepMember } from "./ChatSwitcher.js";
import { startSession } from "./sessionActions.js";
import { appPathFor, CHAT_QUERY, chatQueryId } from "./chatRoute.js";
import { SCOOTER_MARK } from "./brandMark.js";
import { CompactContext, densityStore, useDensity } from "./density.js";

// Whether the conversation stream has delivered its first full list, which is what lets
// "not listed yet" become "not found". Set from main.tsx's onSnapshot.
let listLoaded = false;
const listeners = new Set<() => void>();
export const chatListStatus = {
  markLoaded() {
    if (listLoaded) return;
    listLoaded = true;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => listLoaded,
};

/** Pending approvals, pinned above the thread: the subpage has no Approvals tab to badge. */
function PendingApprovals() {
  const { interrupts } = useConversationInterrupts();
  if (interrupts.length === 0) return null;
  return (
    <section
      data-testid="chat-page-approvals"
      aria-label="Pending approvals"
      className="max-h-[45%] shrink-0 overflow-y-auto border-b bg-card px-3 py-2"
    >
      <InterruptList />
    </section>
  );
}

function Placeholder({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Whether `conversationId` is listed, and open, so its thread may render. */
function usePinned(conversationId: string | undefined) {
  const { sessions, currentId } = useSessions();
  const loaded = useSyncExternalStore(chatListStatus.subscribe, chatListStatus.get, chatListStatus.get);
  if (conversationId === undefined) return { listed: true, loaded, ready: true };
  const listed = sessions.some((s) => s.id === conversationId);
  return { listed, loaded, ready: listed && currentId === conversationId };
}

/**
 * One conversation's pending approvals and thread, without the app around it: the body of
 * this page, and what a contrib view embeds. With an id it opens that conversation;
 * without one it shows whichever is open, a fresh draft included.
 */
export function ChatPanel({ conversationId }: { conversationId?: string }) {
  const { listed, loaded, ready } = usePinned(conversationId);
  useEffect(() => {
    if (conversationId !== undefined && listed) sessionStore.requestSelect(conversationId);
  }, [conversationId, listed]);
  if (ready) {
    return (
      <div data-testid="chat-panel" className="flex h-full min-h-0 flex-col">
        <PendingApprovals />
        <div className="min-h-0 flex-1">
          <ConversationArea />
        </div>
      </div>
    );
  }
  return loaded && !listed ? (
    <Placeholder testId="chat-page-not-found">This conversation doesn't exist, or you don't have access to it.</Placeholder>
  ) : (
    <Placeholder testId="chat-page-loading">Loading conversation…</Placeholder>
  );
}

const LAST_CHAT_KEY = (rootId: string) => `scooter.chat.last.${rootId}`;

function readLastChat(rootId: string): string | undefined {
  try {
    return localStorage.getItem(LAST_CHAT_KEY(rootId)) ?? undefined;
  } catch {
    // Storage can be off in a third-party frame.
    return undefined;
  }
}

/** Which of the sandbox's chats this page shows, and switching it in place. */
function useChatSelection(pathId: string) {
  const { sessions } = useSessions();
  const loaded = useSyncExternalStore(chatListStatus.subscribe, chatListStatus.get, chatListStatus.get);
  const [activeId, setActiveId] = useState(pathId);
  const [error, setError] = useState<string>();
  // A session just started, opened once the list carries it.
  const [starting, setStarting] = useState<string>();
  const members = useMemo(() => familyOf(sessions, pathId), [sessions, pathId]);
  const root = members[0]?.session;
  const rootKey = root ? serverKeyOf(root) : pathId;

  const isMember = (id: string | undefined) => !!id && members.some((m) => m.session.id === id);

  // Only this sandbox's own chats, so a framing page cannot open any other.
  const select = useCallback(
    (id: string) => {
      if (id !== pathId && !isMember(id)) return;
      setError(undefined);
      sessionStore.repin(id);
      setActiveId(id);
      // The path stays the root's: only its sandbox origin may frame it (nginx.nix).
      const url = new URL(location.href);
      if (id === pathId) url.searchParams.delete(CHAT_QUERY);
      else url.searchParams.set(CHAT_QUERY, id);
      history.replaceState(history.state, "", url);
      try {
        localStorage.setItem(LAST_CHAT_KEY(rootKey), id);
      } catch {
        // Storage can be off in a third-party frame; the switch still works.
      }
    },
    [pathId, rootKey, members],
  );

  // On the first list, reopen the chat the URL names, else the one last used here.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !loaded || !root) return;
    restored.current = true;
    const asked = chatQueryId(location.search);
    const want = isMember(asked) ? asked : isMember(readLastChat(rootKey)) ? readLastChat(rootKey) : undefined;
    if (want && want !== activeId) select(want);
    else if (asked && !isMember(asked)) select(pathId);
  });

  // A chat that leaves the list (deleted, or stopped) falls back to the root.
  const wasListed = useRef(false);
  const listed = isMember(activeId);
  useEffect(() => {
    if (listed) wasListed.current = true;
    else if (wasListed.current && root) {
      wasListed.current = false;
      select(root.id);
    }
  }, [listed, root, select]);

  const user = useCurrentUser();
  const startNew = canStartSession(root, user) && starting === undefined
    ? () => {
        void startSession(root, setStarting).then((err) => err && setError(`Couldn't start a session: ${err}`));
      }
    : undefined;

  useEffect(() => {
    if (starting && isMember(starting)) {
      setStarting(undefined);
      select(starting);
    }
  });

  // Alt+Up/Down cycles the chats; Alt+N starts a session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (step !== 0) {
        const next = stepMember(members, activeId, step);
        if (next && next !== activeId) select(next);
        e.preventDefault();
      } else if (e.code === "KeyN" && startNew) {
        startNew();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [members, activeId, select, startNew]);

  return { activeId, members, select, startNew, starting: starting !== undefined, error };
}

export function ChatPage({ conversationId }: { conversationId: string }) {
  const { activeId, members, select, startNew, starting, error } = useChatSelection(conversationId);
  const density = useDensity();
  const compact = density === "compact";

  return (
    <RuntimeProvider>
      <CompactContext.Provider value={compact}>
        <div className="flex h-dvh flex-col" data-testid="chat-page" data-density={density} data-conversation-id={conversationId} data-active-chat={activeId}>
          <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b bg-header px-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-[15px] leading-none" aria-hidden>{SCOOTER_MARK}</span>
              {members.length > 0 && <ChatSwitcher members={members} activeId={activeId} onSelect={select} onNew={startNew} />}
              {starting && (
                <span data-testid="chat-page-starting" className="shrink-0 text-xs text-muted-foreground">
                  Starting session…
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                data-testid="chat-page-density"
                aria-pressed={compact}
                title="Compact view"
                aria-label="Compact view"
                onClick={() => densityStore.set(compact ? "comfortable" : "compact")}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              >
                <Rows4 className="size-4" aria-hidden />
              </button>
              <ThemePicker />
              {/* _top: inside a host's iframe this leaves the host page for the full app. */}
              <a
                data-testid="chat-page-open-app"
                href={appPathFor(activeId)}
                target="_top"
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Open in Scooter <ExternalLink className="ms-1 inline size-3.5" aria-hidden />
              </a>
            </div>
          </header>
          <main className="flex min-h-0 flex-1 flex-col">
            {error && (
              <p data-testid="chat-page-error" role="alert" className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                {error}
              </p>
            )}
            <ChatPanel conversationId={activeId} />
          </main>
        </div>
      </CompactContext.Provider>
    </RuntimeProvider>
  );
}
