/**
 * Sandbox status panel — the leftmost, ALWAYS-visible tab in the RightPanel. Shows
 * the current conversation's pod lifecycle state (Running / Suspended / Ended) and,
 * when suspended, a Start button that resumes the pod (POST /resume) so the user can
 * reach its services without having to send a message.
 *
 * Status is server-owned and live: it flows through the /conversations/events stream
 * into the sessions store (Session.status). The Start button polls until Running so
 * the "Starting…" state resolves on its own (the pod takes a few seconds to come up).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { resumeConversation, loadConversationStatus } from "./client.js";
import { sessionStore, useSessions } from "./sessions.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export type SandboxState = "running" | "suspended" | "ended" | "starting" | "unknown";

/** Track the current conversation's sandbox status + a resume action with live
 *  progress. `state` overlays a transient "starting" while a resume is in flight. */
export function useSandboxStatus() {
  const { currentId, sessions } = useSessions();
  const current = sessions.find((s) => s.id === currentId);
  const serverStatus = current?.status; // "running" | "suspended" | "ended" | undefined
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // If the server reports Running, the resume is done — clear the transient state.
  useEffect(() => {
    if (serverStatus === "running") setStarting(false);
  }, [serverStatus]);

  // Stop polling when the conversation changes / unmounts.
  useEffect(() => () => clearInterval(pollRef.current), []);

  const start = useCallback(async () => {
    if (!currentId) return;
    setStarting(true);
    const res = await resumeConversation({ baseUrl: BASE_URL }, currentId);
    if (!res) {
      setStarting(false);
      return;
    }
    // Poll status through to Running (the /conversations/events stream also updates
    // the store, but a direct poll guarantees the button resolves even if this
    // conversation isn't in the current stream scope).
    clearInterval(pollRef.current);
    let tries = 0;
    pollRef.current = setInterval(async () => {
      tries += 1;
      const st = await loadConversationStatus({ baseUrl: BASE_URL }, currentId);
      if (st) sessionStore.mergeFromServer([{ id: currentId, status: st as never }]);
      if (st === "running" || tries > 30) {
        clearInterval(pollRef.current);
        setStarting(false);
      }
    }, 2000);
  }, [currentId]);

  const state: SandboxState = !current
    ? "unknown"
    : starting && serverStatus !== "running"
      ? "starting"
      : serverStatus ?? "unknown";

  return { state, start, hasConversation: !!current };
}

const LABEL: Record<SandboxState, string> = {
  running: "Running",
  suspended: "Suspended",
  ended: "Ended",
  starting: "Starting…",
  unknown: "Unknown",
};

const DOT: Record<SandboxState, string> = {
  running: "bg-green-500",
  suspended: "bg-amber-500",
  ended: "bg-muted-foreground/40",
  starting: "bg-amber-500 animate-pulse",
  unknown: "bg-muted-foreground/40",
};

export interface SandboxStatusViewProps {
  state: SandboxState;
  onStart: () => void;
}

/** Pure view — the status line + a Start button when the pod is down. */
export function SandboxStatusView({ state, onStart }: SandboxStatusViewProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="sandbox-panel">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[state]}`} aria-hidden />
        <span className="text-sm font-medium" data-testid="sandbox-state" data-state={state}>
          {LABEL[state]}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {state === "running"
          ? "The sandbox pod is up — services are reachable and the agent can work."
          : state === "starting"
            ? "Bringing the sandbox pod up… this takes a few seconds."
            : state === "ended"
              ? "This conversation was ended; its sandbox is gone."
              : state === "suspended"
                ? "The sandbox pod is suspended (idle). Start it to reach its services."
                : "No sandbox for this conversation yet."}
      </p>
      {(state === "suspended" || state === "starting") && (
        <button
          type="button"
          data-testid="sandbox-start"
          disabled={state === "starting"}
          onClick={onStart}
          className="self-start rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-60"
        >
          {state === "starting" ? "Starting…" : "Start sandbox"}
        </button>
      )}
    </div>
  );
}

export function SandboxPanel() {
  const { state, start } = useSandboxStatus();
  return <SandboxStatusView state={state} onStart={() => void start()} />;
}
