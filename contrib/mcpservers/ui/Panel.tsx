/**
 * The MCP servers section (`ui.panel`): the conversation owner's servers from Settings,
 * each with the state the sandbox last reported and the prefix its tools carry. It
 * reads the broker's `/mcpservers/conversation/<id>/servers` through the agent-host's
 * conversation relay, which first checks the user may see this conversation.
 */

import { useEffect, useState } from "react";
import { ChevronRight, Plug } from "lucide-react";

import { cn, conversationFetch, useConversationKey, type PanelProps } from "@/src/contrib/sdk";

/** One server as this section shows it; `state` is null when it is disabled. */
export interface ServerView {
  name: string;
  kind: string;
  spec: string;
  enabled: boolean;
  state: string | null;
  toolPrefix: string;
}

export interface Listing {
  servers: ServerView[];
  reportedAt: string | null;
  error: string | null;
}

const EMPTY: Listing = { servers: [], reportedAt: null, error: null };

interface WireServer {
  name: string;
  kind?: string;
  spec?: string;
  enabled?: boolean;
  state?: string | null;
  tool_prefix?: string;
}

/** Map the broker's listing body, dropping rows without a name. */
export function parseListing(body: unknown): Listing {
  const b = body as { servers?: unknown; reported_at?: unknown; error?: unknown } | null;
  if (!Array.isArray(b?.servers)) return EMPTY;
  return {
    servers: (b.servers as WireServer[])
      .filter((s) => typeof s?.name === "string")
      .map((s) => ({
        name: s.name,
        kind: s.kind ?? "",
        spec: s.spec ?? "",
        enabled: s.enabled !== false,
        state: s.state ?? null,
        toolPrefix: s.tool_prefix ?? `mcp__sandbox-${s.name}__`,
      })),
    reportedAt: typeof b.reported_at === "string" ? b.reported_at : null,
    error: typeof b.error === "string" ? b.error : null,
  };
}

async function load(): Promise<Listing> {
  try {
    const res = await conversationFetch("mcpservers", "servers");
    if (!res?.ok) return EMPTY;
    return parseListing(await res.json());
  } catch {
    return EMPTY;
  }
}

/** The section body, polling every 15s while mounted. */
export default function Panel({ setCount }: PanelProps) {
  const key = useConversationKey();
  const [listing, setListing] = useState<Listing>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void load().then((l) => {
        if (cancelled) return;
        setListing(l);
        setCount(l.servers.length);
      });
    setListing(EMPTY); // clear when switching conversations
    setCount(null);
    refresh();
    const t = setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key, setCount]);

  return <ServerList listing={listing} />;
}

/** A server's state in a word or two; a server not in the report has not started. */
export function stateLabel(s: ServerView, reported: boolean): string {
  if (!s.enabled) return "disabled";
  if (!reported) return "waiting for the sandbox";
  return s.state ?? "not started";
}

/** This conversation's MCP servers, or an empty state. */
export function ServerList({ listing }: { listing: Listing }) {
  const { servers, reportedAt, error } = listing;
  if (servers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="mcpservers-empty">
        No MCP servers. Add one under Settings
        <ChevronRight className="mx-0.5 inline size-3.5 align-[-2px]" role="img" aria-label="then" />
        MCP servers.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-col gap-1.5" data-testid="mcpservers-list">
        {servers.map((s) => {
          const running = s.enabled && s.state === "active";
          return (
            <li
              key={s.name}
              data-testid="mcpserver-item"
              data-server={s.name}
              data-state={stateLabel(s, reportedAt !== null)}
              className="flex items-start gap-2 rounded-lg border bg-card px-3 py-2"
            >
              <Plug
                className={cn("mt-0.5 size-4 shrink-0", running ? "text-foreground" : "text-muted-foreground")}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium" title={`${s.kind} ${s.spec}`}>
                    {s.name}
                  </span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 text-[11px]",
                      running ? "text-success" : s.state === "failed" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {running ? "running" : stateLabel(s, reportedAt !== null)}
                  </span>
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">{s.toolPrefix}</div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground" data-testid="mcpservers-reported">
        {reportedAt ? `As of ${new Date(reportedAt).toLocaleTimeString()}` : "The sandbox has not reported yet."}
        {error ? ` · ${error}` : ""}
      </p>
    </div>
  );
}
