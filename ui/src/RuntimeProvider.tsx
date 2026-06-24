/**
 * AG-UI runtime provider — connects assistant-ui to our agent-host, keyed by the
 * currently-selected session (sessionStore). Switching sessions in the sidebar
 * re-points the HttpAgent at that thread AND hydrates the thread with that
 * conversation's prior turns (loaded from the agent-host's history endpoint).
 *
 * The agent-host exposes the standard AG-UI HttpAgent protocol at /agui
 * (POST RunAgentInput -> SSE AG-UI events). Blessed wiring: HttpAgent ->
 * useAgUiRuntime, adapted from the official with-ag-ui example to Vite/React.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { HttpAgent } from "@ag-ui/client";
import { useAgUiRuntime, fromAgUiMessages } from "@assistant-ui/react-ag-ui";

import { sessionStore, useSessions } from "./sessions.js";
import { loadHistory } from "./client.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");
const AGENT_URL = `${BASE_URL}/agui`;

export function RuntimeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { currentId } = useSessions();

  // Remount the runtime per conversation. useAgUiRuntime owns the thread's
  // message state internally; handing it a new agent mid-render does NOT reset
  // it, so switching/deleting would leave the previous conversation's messages
  // on screen. Keying by currentId tears the runtime down and recreates it for
  // the selected conversation — a real swap, and closing actually changes the
  // view. History is loaded up-front and seeded as the thread's messages.
  return (
    <ConversationRuntime key={currentId} conversationId={currentId}>
      {children}
    </ConversationRuntime>
  );
}

function ConversationRuntime({
  conversationId,
  children,
}: Readonly<{ conversationId: string; children: ReactNode }>) {
  const agent = useMemo(
    () => new HttpAgent({ url: AGENT_URL, threadId: conversationId, headers: { Accept: "text/event-stream" } }),
    [conversationId],
  );

  const threadListAdapter = useMemo(
    () => ({
      threadId: conversationId,
      onSwitchToNewThread: async () => {
        sessionStore.newSession();
      },
      onSwitchToThread: async (threadId: string) => {
        sessionStore.switchTo(threadId);
        return { messages: [] as never };
      },
    }),
    [conversationId],
  );

  const runtime = useAgUiRuntime({ agent, adapters: { threadList: threadListAdapter } });

  // Hydrate this (freshly-remounted) conversation with its history. The agent
  // stores the conversation as AG-UI events; fold them to messages and seed the
  // thread via reset(). Without this, switching to / closing into a conversation
  // shows a blank thread instead of its prior turns.
  //
  // CRITICAL: only reset while the thread is still EMPTY. The runtime is
  // remounted per-conversation (parent's key={currentId}), so this runs once on
  // mount — but the load is async, and if the user has meanwhile started sending
  // in this thread, the live stream owns the messages. Resetting then would wipe
  // an in-progress reply. So we no-op if the thread already has messages.
  useEffect(() => {
    let cancelled = false;
    loadHistory({ baseUrl: BASE_URL }, conversationId).then((history) => {
      if (cancelled || history.length === 0) return;
      // Only seed when the thread is still empty (freshly switched-to). If the
      // user has already started sending here, the live stream owns the messages
      // and resetting would wipe an in-progress reply.
      if (runtime.thread.getState().messages.length > 0) return;
      runtime.thread.reset(fromAgUiMessages(history));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Derive the session title from the first user message of the current thread.
  useEffect(() => {
    return runtime.thread.subscribe(() => {
      const msgs = runtime.thread.getState().messages;
      const firstUser = msgs.find((m) => m.role === "user");
      const text = firstUser?.content
        ?.map((c) => ("text" in c ? c.text : ""))
        .join(" ")
        .trim();
      if (text) sessionStore.titleFromFirstMessage(conversationId, text);
    });
  }, [runtime, conversationId]);

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
