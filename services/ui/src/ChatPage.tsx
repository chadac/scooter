/**
 * The conversation subpage, `/chat/<id>` (chatRoute.ts): one conversation's thread, composer and
 * pending approvals under a thin header, with no sidebar and no right panel. Embedded beside a
 * sandbox's own service (the marimo wrapper) and opened by the main header's "Pop out chat".
 *
 * The page renders the thread only once the server has listed the pinned conversation and it is
 * selected; until then the composer stays hidden, because a send against the placeholder
 * conversation would create a new one. A list that arrives without it means the caller can't
 * see it (or it doesn't exist), which the page says rather than showing an empty thread.
 */

import { useEffect, useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";

import { RuntimeProvider, useConversationInterrupts } from "./RuntimeProvider.js";
import { ConversationArea } from "./App.js";
import { HeaderConversationTitle } from "./HeaderConversationTitle.js";
import { InterruptList } from "./InterruptPanel.js";
import { ThemePicker } from "./ThemePicker.js";
import { sessionStore, useSessions } from "./sessions.js";
import { appPathFor } from "./chatRoute.js";
import { SCOOTER_MARK } from "./brandMark.js";

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

export function ChatPage({ conversationId }: { conversationId: string }) {
  const { ready } = usePinned(conversationId);

  return (
    <RuntimeProvider>
      <div className="flex h-dvh flex-col" data-testid="chat-page" data-conversation-id={conversationId}>
        <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b bg-header px-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[15px] leading-none" aria-hidden>{SCOOTER_MARK}</span>
            {ready && <HeaderConversationTitle />}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ThemePicker />
            {/* _top: inside a host's iframe this leaves the host page for the full app. */}
            <a
              data-testid="chat-page-open-app"
              href={appPathFor(conversationId)}
              target="_top"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Open in Scooter <ExternalLink className="ms-1 inline size-3.5" aria-hidden />
            </a>
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col">
          <ChatPanel conversationId={conversationId} />
        </main>
      </div>
    </RuntimeProvider>
  );
}
