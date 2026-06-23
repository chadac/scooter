/**
 * AG-UI runtime provider — connects assistant-ui to our agent-host.
 *
 * The agent-host exposes the standard AG-UI HttpAgent protocol at /agui
 * (POST RunAgentInput -> SSE stream of AG-UI events). So this is the blessed
 * assistant-ui AG-UI wiring (HttpAgent -> useAgUiRuntime), pointed at the
 * agent-host instead of a generic agent URL. Adapted from the official
 * `with-ag-ui` example (Next.js) to plain Vite/React.
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider, type ThreadMessage } from "@assistant-ui/react";
import { HttpAgent } from "@ag-ui/client";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";

type StoredThread = { id: string; messages: readonly ThreadMessage[] };

const AGENT_URL = `${(import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "")}/agui`;

export function RuntimeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const threadsRef = useRef<Map<string, StoredThread>>(new Map());
  const [currentThreadId, setCurrentThreadId] = useState<string>(() => {
    const id = crypto.randomUUID();
    threadsRef.current.set(id, { id, messages: [] });
    return id;
  });

  const agent = useMemo(
    () =>
      new HttpAgent({
        url: AGENT_URL,
        threadId: currentThreadId,
        headers: { Accept: "text/event-stream" },
      }),
    [currentThreadId],
  );

  const threadListAdapter = useMemo(
    () => ({
      threadId: currentThreadId,
      onSwitchToNewThread: async () => {
        const id = crypto.randomUUID();
        threadsRef.current.set(id, { id, messages: [] });
        setCurrentThreadId(id);
      },
      onSwitchToThread: async (threadId: string) => {
        const thread = threadsRef.current.get(threadId);
        if (!thread) throw new Error(`Thread ${threadId} not found`);
        setCurrentThreadId(threadId);
        return { messages: thread.messages };
      },
    }),
    [currentThreadId],
  );

  const runtime = useAgUiRuntime({
    agent,
    adapters: { threadList: threadListAdapter },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
