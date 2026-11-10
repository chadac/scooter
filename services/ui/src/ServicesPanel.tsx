/**
 * ServiceRows: the web-services list, one compact row per service (status plus
 * start/stop/open), used by the Session tab, which owns the data fetching and
 * pod-status context. A stopped service shows Start; a running one shows Open
 * (/c/<id>/<name>/, reverse-proxied into the pod) and Stop. `onAdd` renders a trailing "add" row when provided.
 */

import { Notebook, SquareTerminal, Code, AppWindow, Power, ExternalLink, Plus, TriangleAlert } from "lucide-react";

import type { WebService } from "./client.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Pick a glyph for a service from its name/label, falling back to a generic window icon. */
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
  /** When set, render a trailing "+ Add service" row that calls this. */
  onAdd?: () => void;
}) {
  if (services.length === 0 && !onAdd) return null;
  return (
    <div className="divide-y overflow-hidden rounded-lg border bg-card" data-testid="service-list">
      {services.map((s) => {
        const Icon = serviceIcon(s);
        const busy = starting[s.name];
        return (
          <div
            key={s.name}
            data-testid="service-item"
            data-service={s.name}
            data-running={s.running}
            className="flex items-center gap-2 px-2 py-1.5"
          >
            <span className="relative shrink-0" aria-hidden>
              <Icon className={cn("size-4", s.running ? "text-foreground" : "text-muted-foreground")} />
              {/* Filled dot = running; hollow ring = stopped. */}
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-card",
                  s.running ? "bg-success" : "border border-muted-foreground/60 bg-card",
                )}
              />
            </span>

            <div className="min-w-0 flex-1">
              <div
                className={cn("truncate text-sm", s.running ? "font-medium" : "text-muted-foreground")}
                title={s.displayName}
              >
                {s.displayName}
              </div>
              {/* Advisory that this service declares more than the sandbox caps at; full sentence on hover. */}
              {s.fitShort ? (
                <div
                  data-testid="service-fit"
                  title={s.fit}
                  className="flex items-center gap-1 truncate text-[11px] leading-snug text-warning"
                >
                  <TriangleAlert className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{s.fitShort}</span>
                </div>
              ) : null}
            </div>

            {s.running ? (
              <a
                data-testid="service-open"
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground hover:underline"
              >
                Open
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}

            {s.running ? (
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid="service-stop"
                disabled={busy}
                onClick={() => onStop?.(s.name)}
                title="Stop"
                aria-label={`Stop ${s.displayName}`}
                className="shrink-0 rounded-full text-success hover:text-destructive"
              >
                {busy ? "…" : <Power className="size-3.5" aria-hidden />}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size={busy ? "xs" : "icon-xs"}
                data-testid="service-start"
                disabled={busy}
                onClick={() => onStart(s.name)}
                title="Start"
                aria-label={`Start ${s.displayName}`}
                className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              >
                {busy ? "Starting…" : <Power className="size-3.5" aria-hidden />}
              </Button>
            )}
          </div>
        );
      })}

      {onAdd && (
        <button
          type="button"
          data-testid="service-add"
          onClick={onAdd}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <Plus className="size-4" aria-hidden />
          Add service
        </button>
      )}
    </div>
  );
}
