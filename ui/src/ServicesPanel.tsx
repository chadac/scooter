/**
 * Per-conversation Services panel. Lists the web services declared in the
 * conversation's sandbox (marimo/xterm/…) and lets the user Start one and Open it
 * in the browser at /c/<id>/<name>/ (the agent-host reverse-proxies into the pod).
 *
 * Hidden entirely when the conversation declares no services (the common case) —
 * so it's invisible until an agent enables one. A plain button + list, reliable to
 * drive in e2e, zero extra deps. Explicit-start model: Start issues the start,
 * then the row's Open link becomes active (a service is opened, not embedded).
 */

import { useCallback, useEffect, useState } from "react";

import { loadWebServices, startWebService, stopWebService, type WebService } from "./client.js";
import { useSessions } from "./sessions.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

/** Poll the current conversation's web services (used by the RightPanel Services
 *  tab). Exposed so the tab can show a live count + start/stop each service. */
export function useWebServices() {
  const { currentId } = useSessions();
  const [services, setServices] = useState<WebService[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    if (!currentId) return;
    setServices(await loadWebServices({ baseUrl: BASE_URL }, currentId));
  }, [currentId]);

  // Load on conversation change, then poll (a service the agent just enabled/started
  // should appear/flip to running without a reload). Kept modest (4s).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (name: string, fn: typeof startWebService) => {
    setBusy((b) => ({ ...b, [name]: true }));
    await fn({ baseUrl: BASE_URL }, currentId, name);
    await refresh();
    setBusy((b) => ({ ...b, [name]: false }));
  };

  return {
    services,
    busy,
    start: (name: string) => void act(name, startWebService),
    stop: (name: string) => void act(name, stopWebService),
  };
}

export function ServicesPanel() {
  const { services, busy, start, stop } = useWebServices();
  const [open, setOpen] = useState(false);
  return (
    <ServicesPanelView
      services={services}
      open={open}
      starting={busy}
      onToggle={() => setOpen((o) => !o)}
      onStart={start}
      onStop={stop}
    />
  );
}

export interface ServicesPanelViewProps {
  services: WebService[];
  open: boolean;
  starting: Record<string, boolean>;
  onToggle: () => void;
  onStart: (name: string) => void;
  onStop?: (name: string) => void;
}

/** Pure view (no data fetching) — easy to unit-test. Renders as a collapsible when
 *  `onToggle` matters (legacy sidebar use); the RightPanel tab passes open=true and
 *  uses ServiceRows directly via `bare`. */
export function ServicesPanelView({ services, open, starting, onToggle, onStart, onStop }: ServicesPanelViewProps) {
  // Nothing declared -> don't show the affordance at all.
  if (services.length === 0) return null;

  return (
    <div className="aui-services-panel px-2 text-xs" data-testid="services-panel">
      <button
        type="button"
        data-testid="services-toggle"
        aria-expanded={open}
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground"
      >
        Services ({services.length})
      </button>
      {open && <ServiceRows services={services} starting={starting} onStart={onStart} onStop={onStop} />}
    </div>
  );
}

/** The list rows — start/stop toggle + Open. Shared by the collapsible and the tab. */
export function ServiceRows({
  services,
  starting,
  onStart,
  onStop,
}: {
  services: WebService[];
  starting: Record<string, boolean>;
  onStart: (name: string) => void;
  onStop?: (name: string) => void;
}) {
  return (
    <ul className="mt-1 flex flex-col gap-1" data-testid="service-list">
      {services.map((s) => (
        <li
          key={s.name}
          data-testid="service-item"
          data-service={s.name}
          data-running={s.running}
          className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1"
        >
          <span className="flex min-w-0 items-center gap-1">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.running ? "bg-green-500" : "bg-muted-foreground/40"}`}
              aria-hidden
            />
            <span className="truncate">{s.displayName}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {s.running && (
              <a
                data-testid="service-open"
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline"
              >
                Open
              </a>
            )}
            {s.running ? (
              <button
                type="button"
                data-testid="service-stop"
                disabled={starting[s.name]}
                onClick={() => onStop?.(s.name)}
                className="rounded-md border border-border bg-background px-2 py-0.5 text-muted-foreground hover:text-destructive disabled:opacity-50"
              >
                {starting[s.name] ? "…" : "Stop"}
              </button>
            ) : (
              <button
                type="button"
                data-testid="service-start"
                disabled={starting[s.name]}
                onClick={() => onStart(s.name)}
                className="rounded-md border border-border bg-background px-2 py-0.5 text-foreground disabled:opacity-50"
              >
                {starting[s.name] ? "Starting…" : "Start"}
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
