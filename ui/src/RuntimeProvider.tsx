/**
 * AG-UI runtime provider — connects assistant-ui to our agent-host, keyed by the
 * currently-selected session (sessionStore). Switching sessions in the sidebar
 * re-points the HttpAgent at that thread.
 *
 * The agent-host exposes the standard AG-UI HttpAgent protocol at /agui
 * (POST RunAgentInput -> SSE AG-UI events). Blessed wiring: HttpAgent ->
 * useAgUiRuntime, adapted from the official with-ag-ui example to Vite/React.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { HttpAgent } from "@ag-ui/client";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";

import { sessionStore, useSessions } from "./sessions.js";

const AGENT_URL = `${(import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "")}/agui`;

export function RuntimeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { currentId } = useSessions();

  const agent = useMemo(
    () => new HttpAgent({ url: AGENT_URL, threadId: currentId, headers: { Accept: "text/event-stream" } }),
    [currentId],
  );

  const threadListAdapter = useMemo(
    () => ({
      threadId: currentId,
      onSwitchToNewThread: async () => {
        sessionStore.newSession();
      },
      onSwitchToThread: async (threadId: string) => {
        sessionStore.switchTo(threadId);
        return { messages: [] };
      },
    }),
    [currentId],
  );

  const runtime = useAgUiRuntime({ agent, adapters: { threadList: threadListAdapter } });

  // Derive the session title from the first user message of the current thread.
  useEffect(() => {
    return runtime.thread.subscribe(() => {
      const msgs = runtime.thread.getState().messages;
      const firstUser = msgs.find((m) => m.role === "user");
      const text = firstUser?.content
        ?.map((c) => ("text" in c ? c.text : ""))
        .join(" ")
        .trim();
      if (text) sessionStore.titleFromFirstMessage(currentId, text);
    });
  }, [runtime, currentId]);

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
