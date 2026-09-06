/**
 * ServiceRows — the web-services grid (per-service status + start/stop/open). Used by
 * the Sandbox tab (SandboxPanel), which owns the data fetching + pod-status context.
 *
 * Explicit-start model: a stopped service shows Start; a running one shows Open (opens
 * /c/<id>/<name>/, reverse-proxied into the pod) + Stop. Each service is a card in a
 * two-column grid; `onAdd` renders a trailing dashed "add" card when provided.
 */

import { Notebook, SquareTerminal, Code, AppWindow, Power, ExternalLink, Plus } from "lucide-react";

import type { WebService } from "./client.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Pick a glyph for a service from its name/label. Purely cosmetic — an unknown
 *  service falls back to a generic window icon, so a new service type never renders
 *  blank. */
function serviceIcon(s: WebService): typeof AppWindow {
  const key = `${s.name} ${s.displayName}`.toLowerCase();
  if (/marimo|jupyter|notebook/.test(key)) return Notebook;
  if (/term|ttyd|wetty|shell|bash|tty/.test(key)) return SquareTerminal;
  if (/vscode|vs ?code|code-?server|\bcode\b/.test(key)) return Code;
  return AppWindow;
}

export function ServiceRows({
  services,
  starting,
  onStart,
  onStop,
  onAdd,
}: {
  services: WebService[];
  starting: Record<string, boolean>;
  onStart: (name: string) => void;
  onStop?: (name: string) => void;
  /** When set, render a trailing dashed "+ Service" card that calls this. Web
   *  services are declared in-sandbox (not created from here), so this surfaces a
   *  hint rather than a create form. */
  onAdd?: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="service-list">
      {services.map((s) => {
        const Icon = serviceIcon(s);
        const busy = starting[s.name];
        return (
          <div
            key={s.name}
            data-testid="service-item"
            data-service={s.name}
            data-running={s.running}
            className="flex min-h-[7rem] flex-col rounded-lg border bg-card p-3"
          >
            <div className="flex items-start justify-between">
              <span
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-md border",
                  s.running ? "bg-muted/50 text-foreground" : "bg-muted/30 text-muted-foreground",
                )}
                aria-hidden
              >
                <Icon className="size-4" />
              </span>
              {/* Filled dot = running; hollow ring = stopped. */}
              <span
                className={cn(
                  "mt-1 inline-block h-2.5 w-2.5 rounded-full",
                  s.running ? "bg-success" : "border border-muted-foreground/40",
                )}
                aria-hidden
              />
            </div>

            <div className="mt-2 truncate text-sm font-medium" title={s.displayName}>
              {s.displayName}
            </div>

            <div className="mt-auto flex items-center justify-between pt-2">
              {s.running ? (
                <a
                  data-testid="service-open"
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
                >
                  Open
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">Stopped</span>
              )}

              {s.running ? (
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="service-stop"
                  disabled={busy}
                  onClick={() => onStop?.(s.name)}
                  title="Stop"
                  aria-label={`Stop ${s.displayName}`}
                  className="rounded-full text-success hover:text-destructive"
                >
                  {busy ? "…" : <Power className="size-3.5" aria-hidden />}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  data-testid="service-start"
                  disabled={busy}
                  onClick={() => onStart(s.name)}
                  title="Start"
                  aria-label={`Start ${s.displayName}`}
                  className="rounded-full"
                >
                  {busy ? "Starting…" : <Power className="size-3.5" aria-hidden />}
                </Button>
              )}
            </div>
          </div>
        );
      })}

      {onAdd && (
        <button
          type="button"
          data-testid="service-add"
          onClick={onAdd}
          className="flex min-h-[7rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Plus className="size-4" aria-hidden />
          <span className="text-xs">Service</span>
        </button>
      )}
    </div>
  );
}
