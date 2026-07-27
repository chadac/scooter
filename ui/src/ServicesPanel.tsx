/**
 * ServiceRows — the web-services list (per-service status + start/stop/open). Used by
 * the Sandbox tab (SandboxPanel), which owns the data fetching + pod-status context.
 *
 * Explicit-start model: a stopped service shows Start; a running one shows Open (opens
 * /c/<id>/<name>/, reverse-proxied into the pod) + Stop.
 */

import type { WebService } from "./client.js";

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
