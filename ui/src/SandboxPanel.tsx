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
  loadSandboxReady,
  loadSandboxResources,
  loadWebServices,
  startWebService,
  stopWebService,
  searchModules,
  installModule,
  type WebService,
  type RegistryModule,
  type SandboxResources,
} from "./client.js";
import { agentHostConfig } from "./config.js";
import { useSessions } from "./sessions.js";
import { ServiceRows } from "./ServicesPanel.js";
import { Button } from "@/components/ui/button";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export type SandboxState = "running" | "suspended" | "ended" | "starting" | "unknown";

/** Everything the Sandbox tab needs: live pod status (fetched for the current
 *  conversation), a resume action with progress, and the service list + controls. */
export function useSandboxStatus() {
  const { currentId } = useSessions();
  const [serverStatus, setServerStatus] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [services, setServices] = useState<WebService[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Fetch status + ACTUAL pod readiness DIRECTLY for the current conversation (not via
  // the store), so it's accurate even when suspended / deep-linked. `ready` is false
  // while the pod is still ContainerCreating (status is "running" then) — so the UI
  // shows "Starting…" until it's genuinely up. Poll while mounted.
  const refreshStatus = useCallback(async () => {
    if (!currentId) return;
    const { status, ready: r } = await loadSandboxReady({ baseUrl: BASE_URL }, currentId);
    if (status && status !== "unknown") setServerStatus(status);
    setReady(r);
  }, [currentId]);

  const refreshServices = useCallback(async () => {
    if (!currentId) return;
    setServices(await loadWebServices({ baseUrl: BASE_URL }, currentId));
  }, [currentId]);

  useEffect(() => {
    setServerStatus(undefined); // reset on conversation switch
    setReady(false);
    void refreshStatus();
    void refreshServices();
    const t = setInterval(() => {
      void refreshStatus();
      void refreshServices();
    }, 4000);
    return () => clearInterval(t);
  }, [refreshStatus, refreshServices]);

  // The resume is "done" only when the pod is actually READY (not merely status
  // "running", which is true while it's still ContainerCreating).
  useEffect(() => {
    if (serverStatus === "running" && ready) setStarting(false);
  }, [serverStatus, ready]);

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

  // "running" ONLY when the pod is actually ready. status="running" but not ready =
  // the pod is coming up (ContainerCreating) → show "starting". A resume in flight
  // also shows "starting" until ready.
  const state: SandboxState =
    serverStatus === "running"
      ? ready
        ? "running"
        : "starting"
      : starting
        ? "starting"
        : (serverStatus as SandboxState) ?? "unknown";

  return {
    state,
    starting,
    services,
    busy,
    conversationId: currentId ?? undefined,
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
  running: "bg-success",
  suspended: "bg-warning",
  ended: "bg-muted-foreground/40",
  starting: "bg-warning animate-pulse",
  unknown: "bg-muted-foreground/40 animate-pulse",
};

/** Search + install Nix MODULES from the broker registry into this sandbox. Runs
 *  in-pod (scooter-rebuild), so it's shown only while the pod is running. */
export function ModulesSection({ conversationId }: { conversationId: string }) {
  const [query, setQuery] = useState("");
  const [modules, setModules] = useState<RegistryModule[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const runSearch = useCallback(async (q: string) => {
    setLoading(true);
    const res = await searchModules(agentHostConfig, conversationId, q);
    setConfigured(res.configured);
    setModules(res.modules);
    setLoading(false);
  }, [conversationId]);

  useEffect(() => { void runSearch(""); }, [runSearch]);

  const install = async (ref: string) => {
    setInstalling(ref);
    setNote(null);
    try {
      const msg = await installModule(agentHostConfig, conversationId, ref);
      setNote(msg);
      await runSearch(query); // refresh the attached flags
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div data-testid="modules-section">
      <div className="mb-1 text-xs font-medium text-muted-foreground">Modules</div>
      <form
        onSubmit={(e) => { e.preventDefault(); void runSearch(query); }}
        className="mb-2 flex gap-1"
      >
        <input
          data-testid="module-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search modules…"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
        />
        <Button variant="outline" size="xs" type="submit">
          Search
        </Button>
      </form>

      {!configured ? (
        <p data-testid="modules-unavailable" className="text-xs text-muted-foreground">
          The module registry isn’t available.
        </p>
      ) : loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : modules.length === 0 ? (
        <p data-testid="modules-empty" className="text-xs text-muted-foreground">No modules found.</p>
      ) : (
        <ul data-testid="module-list" className="flex flex-col gap-1">
          {modules.map((m) => (
            <li key={m.id} data-testid="module-item" className="flex items-start gap-2 rounded-md border p-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{m.name}</span>
                  {m.visibility === "private" && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">private</span>
                  )}
                </div>
                {m.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{m.description}</p>}
              </div>
              {m.attached ? (
                <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-success/15 text-success">
                  installed
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="module-install"
                  disabled={installing === m.name}
                  onClick={() => void install(m.name)}
                  className="shrink-0"
                >
                  {installing === m.name ? "Installing…" : "Install"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && <p data-testid="module-note" className="mt-1 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

/** Does a resources object carry any value worth showing? (all-empty -> skip the row) */
function hasResources(r: SandboxResources | null | undefined): r is SandboxResources {
  if (!r) return false;
  const sides = [r.requests, r.limits];
  return sides.some((q) => q && (q.cpu !== undefined || q.memory !== undefined || q.gpu !== undefined));
}

/** Format one side (requests | limits) as "cpu · memory · N GPU", omitting absent
 *  fields. Returns "" when the side has nothing. */
function formatQuantity(q: SandboxResources["requests"]): string {
  if (!q) return "";
  const parts: string[] = [];
  if (q.cpu) parts.push(`${q.cpu} CPU`);
  if (q.memory) parts.push(q.memory);
  if (q.gpu) parts.push(`${q.gpu} GPU`);
  return parts.join(" · ");
}

/** Sandbox resource allotment — requests (guaranteed) + limits (ceiling), so the
 *  user can see what the pod is sized for. Rendered only when there's something to
 *  show (the broker-owned size; absent in fake mode). */
export function ResourcesSection({ resources }: { resources: SandboxResources }) {
  const requests = formatQuantity(resources.requests);
  const limits = formatQuantity(resources.limits);
  return (
    <div data-testid="sandbox-resources">
      <div className="mb-1 text-xs font-medium text-muted-foreground">Resources</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {requests && (
          <>
            <dt className="text-muted-foreground" title="Guaranteed — reserved for this sandbox">
              Requested
            </dt>
            <dd data-testid="sandbox-resources-requests" className="font-mono text-foreground">{requests}</dd>
          </>
        )}
        {limits && (
          <>
            <dt className="text-muted-foreground" title="Ceiling — the sandbox can burst up to this">
              Limit
            </dt>
            <dd data-testid="sandbox-resources-limits" className="font-mono text-foreground">{limits}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

export interface SandboxPanelViewProps {
  state: SandboxState;
  services: WebService[];
  busy: Record<string, boolean>;
  conversationId?: string;
  /** The conversation's owner (the user who created it), or undefined/null when
   *  unowned (a legacy conversation or a webhook that couldn't resolve a user). */
  owner?: string | null;
  /** The sandbox's resource allotment (cpu/memory/gpu). null/empty -> not shown. */
  resources?: SandboxResources | null;
  onStartSandbox: () => void;
  onStartService: (name: string) => void;
  onStopService: (name: string) => void;
}

/** Pure view — status line + (when running) the service list, or a Start prompt. */
export function SandboxPanelView({
  state,
  services,
  busy,
  conversationId,
  owner,
  resources,
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
          <Button
            variant="default"
            size="xs"
            data-testid="sandbox-start"
            disabled={state === "starting"}
            onClick={onStartSandbox}
            className="ml-auto"
          >
            {state === "starting" ? "Starting…" : "Start sandbox"}
          </Button>
        )}
      </div>

      {/* Owner — who created this conversation. Hidden when unowned (nothing to
          show) so the field never reads a meaningless blank/"anonymous". */}
      {owner ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="sandbox-owner">
          <span className="font-medium">Owner</span>
          <span data-testid="sandbox-owner-value">{owner}</span>
        </div>
      ) : null}

      {/* Resource allotment — shown regardless of running state (the size is set even
          while suspended, and it's what the pod will come up with). */}
      {hasResources(resources) ? <ResourcesSection resources={resources} /> : null}

      {/* Body: services + modules when running; a hint otherwise. */}
      {state === "running" ? (
        <>
          {services.length > 0 ? (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Web services</div>
              <ServiceRows services={services} starting={busy} onStart={onStartService} onStop={onStopService} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="sandbox-no-services">
              No web services declared in this sandbox.
            </p>
          )}
          {conversationId && <ModulesSection conversationId={conversationId} />}
        </>
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
  const { sessions, currentId } = useSessions();
  const owner = sessions.find((x) => x.id === currentId)?.owner ?? null;

  // The sandbox size (broker-owned). Fetched per conversation; re-fetched when it
  // comes up (the broker applies a pending size on restart, so a just-started pod
  // may report a freshly-applied size). null when unavailable (fake mode) -> hidden.
  const [resources, setResources] = useState<SandboxResources | null>(null);
  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    void loadSandboxResources({ baseUrl: BASE_URL }, currentId).then((r) => {
      if (alive) setResources(r);
    });
    return () => {
      alive = false;
    };
  }, [currentId, s.state]);

  return (
    <SandboxPanelView
      state={s.state}
      services={s.services}
      busy={s.busy}
      conversationId={s.conversationId}
      owner={owner}
      resources={resources}
      onStartSandbox={() => void s.startSandbox()}
      onStartService={s.startService}
      onStopService={s.stopService}
    />
  );
}
