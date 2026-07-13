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

import { loadWebServices, startWebService, type WebService } from "./client.js";
import { useSessions } from "./sessions.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export function ServicesPanel() {
  const { currentId } = useSessions();
  const [services, setServices] = useState<WebService[]>([]);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    if (!currentId) return;
    setServices(await loadWebServices({ baseUrl: BASE_URL }, currentId));
  }, [currentId]);

  // Load on conversation change, then poll while the panel is open (a service the
  // agent just enabled/started should appear/flip to running without a reload).
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [open, refresh]);

  const start = async (name: string) => {
    setStarting((s) => ({ ...s, [name]: true }));
    await startWebService({ baseUrl: BASE_URL }, currentId, name);
    await refresh();
    setStarting((s) => ({ ...s, [name]: false }));
  };

  return (
    <ServicesPanelView
      services={services}
      open={open}
      starting={starting}
      onToggle={() => setOpen((o) => !o)}
      onStart={(name) => void start(name)}
    />
  );
}

export interface ServicesPanelViewProps {
  services: WebService[];
  open: boolean;
  starting: Record<string, boolean>;
  onToggle: () => void;
  onStart: (name: string) => void;
}

/** Pure view (no data fetching) — easy to unit-test. */
export function ServicesPanelView({ services, open, starting, onToggle, onStart }: ServicesPanelViewProps) {
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
      {open && (
        <ul className="mt-1 flex flex-col gap-1">
          {services.map((s) => (
            <li
              key={s.name}
              data-testid="service-item"
              data-service={s.name}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1"
            >
              <span className="flex items-center gap-1">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${s.running ? "bg-green-500" : "bg-muted-foreground/40"}`}
                  aria-hidden
                />
                {s.displayName}
              </span>
              <span className="flex items-center gap-2">
                {s.running ? (
                  <a
                    data-testid="service-open"
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground underline"
                  >
                    Open
                  </a>
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
      )}
    </div>
  );
}
