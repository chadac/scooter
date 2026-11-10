/** The icon telling a child conversation's kind and where it was started from. */

import { Bot, Code2, MessageSquare } from "lucide-react";

import type { Session } from "./sessions.js";
import { cn } from "@/lib/utils";

const ORIGINS: Record<string, { Icon: typeof Bot; label: string }> = {
  vscode: { Icon: Code2, label: "A VS Code chat in this sandbox" },
  web: { Icon: MessageSquare, label: "A chat started from the web in this sandbox" },
};

/** What a child's icon shows, or undefined for a top-level conversation. */
export function childBadge(s: Pick<Session, "kind" | "origin">): { Icon: typeof Bot; label: string } | undefined {
  if (s.kind === "subagent") return { Icon: Bot, label: "A subagent the agent spawned" };
  if (s.kind !== "session") return undefined;
  return ORIGINS[s.origin ?? ""] ?? { Icon: MessageSquare, label: s.origin ? `A ${s.origin} chat in this sandbox` : "A chat in this sandbox" };
}

export function ChildIcon({ session, className }: { session: Pick<Session, "kind" | "origin">; className?: string }) {
  const badge = childBadge(session);
  if (!badge) return null;
  const { Icon, label } = badge;
  return (
    <span
      data-testid="child-icon"
      data-origin={session.kind === "session" ? (session.origin ?? "") : session.kind}
      className={cn("shrink-0 text-muted-foreground", className)}
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon className="size-3" aria-hidden />
    </span>
  );
}
