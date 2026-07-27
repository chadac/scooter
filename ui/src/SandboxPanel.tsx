/**
 * Sandbox panel — the single, always-visible tab for everything about the current
 * conversation's sandbox pod:
 *   • pod lifecycle status (Running / Suspended / Ended) with a Start button when down;
 *   • when running, the list of web services with per-service status + start/stop/open.
 *
 * Status is fetched DIRECTLY for the current conversation (loadConversationStatus),
 * not read off the sessions store — so it's correct regardless of how the conversation
 * was selected (deep link, new chat, etc.), including while the pod is suspended (the
 * store's list can lag / omit a suspended conv, which showed "Unknown"). Services live
 * in the pod's in-manifest, so they're only enumerable while the pod is running; when
 * suspended we show the Start prompt and services appear once it's up.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  resumeConversation,
  loadConversationStatus,
  loadWebServices,
  startWebService,
  stopWebService,
  type WebService,
} from "./client.js";
import { useSessions } from "./sessions.js";
import { ServiceRows } from "./ServicesPanel.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export type SandboxState = "running" | "suspended" | "ended" | "starting" | "unknown";

/** Everything the Sandbox tab needs: live pod status (fetched for the current
 *  conversation), a resume action with progress, and the service list + controls. */
export function useSandboxStatus() {
  const { currentId } = useSessions();
  const [serverStatus, setServerStatus] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [services, setServices] = useState<WebService[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Fetch the pod status DIRECTLY for the current conversation (not via the store),
  // so it's accurate even when suspended / deep-linked. Poll while mounted.
  const refreshStatus = useCallback(async () => {
    if (!currentId) return;
    const st = await loadConversationStatus({ baseUrl: BASE_URL }, currentId);
    if (st) setServerStatus(st);
  }, [currentId]);

  const refreshServices = useCallback(async () => {
    if (!currentId) return;
    setServices(await loadWebServices({ baseUrl: BASE_URL }, currentId));
  }, [currentId]);

  useEffect(() => {
    setServerStatus(undefined); // reset on conversation switch
    void refreshStatus();
    void refreshServices();
    const t = setInterval(() => {
      void refreshStatus();
      void refreshServices();
    }, 4000);
    return () => clearInterval(t);
  }, [refreshStatus, refreshServices]);

  useEffect(() => {
    if (serverStatus === "running") setStarting(false);
  }, [serverStatus]);

  const startSandbox = useCallback(async () => {
    if (!currentId) return;
    setStarting(true);
    const res = await resumeConversation({ baseUrl: BASE_URL }, currentId);
    if (!res) {
      setStarting(false);
      return;
    }
    await refreshStatus();
    await refreshServices();
  }, [currentId, refreshStatus, refreshServices]);

  const act = async (name: string, fn: typeof startWebService) => {
    setBusy((b) => ({ ...b, [name]: true }));
    await fn({ baseUrl: BASE_URL }, currentId, name);
    await refreshServices();
    setBusy((b) => ({ ...b, [name]: false }));
  };

  const state: SandboxState = starting && serverStatus !== "running"
    ? "starting"
    : (serverStatus as SandboxState) ?? "unknown";

  return {
    state,
    services,
    busy,
    startSandbox,
    startService: (name: string) => void act(name, startWebService),
    stopService: (name: string) => void act(name, stopWebService),
    hasConversation: !!currentId,
  };
}

const LABEL: Record<SandboxState, string> = {
  running: "Running",
  suspended: "Suspended",
  ended: "Ended",
  starting: "Starting…",
  unknown: "Checking…",
};

const DOT: Record<SandboxState, string> = {
  running: "bg-green-500",
  suspended: "bg-amber-500",
  ended: "bg-muted-foreground/40",
  starting: "bg-amber-500 animate-pulse",
  unknown: "bg-muted-foreground/40 animate-pulse",
};

export interface SandboxPanelViewProps {
  state: SandboxState;
  services: WebService[];
  busy: Record<string, boolean>;
  onStartSandbox: () => void;
  onStartService: (name: string) => void;
  onStopService: (name: string) => void;
}

/** Pure view — status line + (when running) the service list, or a Start prompt. */
export function SandboxPanelView({
  state,
  services,
  busy,
  onStartSandbox,
  onStartService,
  onStopService,
}: SandboxPanelViewProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="sandbox-panel">
      {/* Pod status */}
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[state]}`} aria-hidden />
        <span className="text-sm font-medium" data-testid="sandbox-state" data-state={state}>
          {LABEL[state]}
        </span>
        {(state === "suspended" || state === "starting") && (
          <button
            type="button"
            data-testid="sandbox-start"
            disabled={state === "starting"}
            onClick={onStartSandbox}
            className="ml-auto rounded-md bg-foreground px-2.5 py-1 text-xs text-background disabled:opacity-60"
          >
            {state === "starting" ? "Starting…" : "Start sandbox"}
          </button>
        )}
      </div>

      {/* Body: services when running; a hint otherwise. */}
      {state === "running" ? (
        services.length > 0 ? (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Web services</div>
            <ServiceRows services={services} starting={busy} onStart={onStartService} onStop={onStopService} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="sandbox-no-services">
            No web services declared in this sandbox.
          </p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          {state === "suspended"
            ? "The sandbox pod is suspended (idle). Start it to reach its web services."
            : state === "starting"
              ? "Bringing the sandbox pod up… services appear once it's running."
              : state === "ended"
                ? "This conversation was ended; its sandbox is gone."
                : "Checking the sandbox status…"}
        </p>
      )}
    </div>
  );
}

export function SandboxPanel() {
  const s = useSandboxStatus();
  return (
    <SandboxPanelView
      state={s.state}
      services={s.services}
      busy={s.busy}
      onStartSandbox={() => void s.startSandbox()}
      onStartService={s.startService}
      onStopService={s.stopService}
    />
  );
}
