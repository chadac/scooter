/**
 * Linked-resources panel — the external resources (GitHub PR / GitLab MR / Slack
 * thread / Jira ticket) a conversation came from, shown under a collapsible tab.
 *
 * The links are pushed to the agent-host by the webhooks service on create and
 * served at GET /conversations/:id/links. We poll lightly so a link that arrives
 * after the conversation opens still appears.
 */

import { useEffect, useState } from "react";

import { loadLinks, type ConversationLink } from "./client.js";
import { useSessions } from "./sessions.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

/** A tiny inline glyph per source (no icon dependency). */
function sourceGlyph(source: string): string {
  switch (source) {
    case "github":
      return "";
    case "gitlab":
      return "🦊";
    case "slack":
      return "";
    case "jira":
      return "📋";
    default:
      return "🔗";
  }
}

function linkLabel(l: ConversationLink): string {
  if (l.title) return l.title;
  const kind = l.resourceType.replace(/_/g, " ");
  return `${l.source} ${kind}`;
}

export function LinkedResources() {
  const { currentId } = useSessions();
  const [links, setLinks] = useState<ConversationLink[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void loadLinks({ baseUrl: BASE_URL }, currentId).then((ls) => {
        if (!cancelled) setLinks(ls);
      });
    setLinks([]); // clear when switching conversations
    refresh();
    const t = setInterval(refresh, 10000); // a late-arriving link still shows
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [currentId]);

  if (links.length === 0) return null;

  return (
    <div className="border-t text-sm" data-testid="linked-resources">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-muted-foreground hover:bg-accent/50"
        onClick={() => setOpen((o) => !o)}
        data-testid="linked-resources-toggle"
      >
        <span>Linked ({links.length})</span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="px-2 pb-2">
          {links.map((l, i) => (
            <li key={`${l.source}-${l.resourceType}-${i}`} data-testid="linked-resource">
              {l.url ? (
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent"
                  title={linkLabel(l)}
                >
                  <span aria-hidden>{sourceGlyph(l.source)}</span>
                  <span className="truncate">{linkLabel(l)}</span>
                </a>
              ) : (
                <span className="flex items-center gap-2 px-2 py-1" title={linkLabel(l)}>
                  <span aria-hidden>{sourceGlyph(l.source)}</span>
                  <span className="truncate">{linkLabel(l)}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
