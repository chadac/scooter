/**
 * The Session tab's MCP servers: useMcpServers polls the sandbox's declared servers, and
 * McpServerRows lists each with its running state and the prefix its tools carry.
 */

import { useCallback, useEffect, useState } from "react";
import { Plug } from "lucide-react";

import { loadMcpServers, type SandboxMcpServer } from "./client.js";
import { useSessions, currentConversation } from "./sessions.js";
import { pollWhileVisible } from "./visiblePoll.js";
import { cn } from "@/lib/utils";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

/** The current conversation's MCP servers, polled while its sandbox is running. */
export function useMcpServers(running: boolean) {
  const { currentId } = useSessions();
  const [servers, setServers] = useState<SandboxMcpServer[]>([]);

  const refresh = useCallback(async (force = false) => {
    const rows = await currentConversation()?.ifCreated(
      (id) => loadMcpServers({ baseUrl: BASE_URL }, id, { refresh: force }),
      [] as SandboxMcpServer[],
    );
    // Same rows keep the old array, so a quiet poll re-renders nothing.
    if (rows) setServers((prev) => (JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows));
  }, [currentId]);

  useEffect(() => setServers([]), [currentId]);

  // Slower than services: each read execs into the pod per server.
  useEffect(() => {
    if (!running) return;
    void refresh();
    return pollWhileVisible(() => void refresh(), 15_000);
  }, [refresh, running]);

  return { servers, refresh };
}

export function McpServerRows({ servers }: { servers: SandboxMcpServer[] }) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid="mcp-server-list">
      {servers.map((s) => (
        <li
          key={s.name}
          data-testid="mcp-server-item"
          data-server={s.name}
          data-running={s.running}
          className="flex items-start gap-2 rounded-lg border bg-card px-3 py-2"
        >
          <Plug
            className={cn("mt-0.5 size-4 shrink-0", s.running ? "text-foreground" : "text-muted-foreground")}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium" title={s.description || s.displayName}>
                {s.displayName}
              </span>
              {/* Filled dot = running; hollow ring = stopped. */}
              <span
                className={cn(
                  "ml-auto inline-block h-2.5 w-2.5 shrink-0 rounded-full",
                  s.running ? "bg-success" : "border border-muted-foreground/40",
                )}
                aria-hidden
              />
              <span className="sr-only">{s.running ? "running" : "stopped"}</span>
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {s.toolPrefix}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
