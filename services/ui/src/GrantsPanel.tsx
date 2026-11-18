/**
 * The Grants section of the Approvals tab: what this conversation may do without a card
 * and until when, with extend (or indefinite), revive and revoke. Active grants show
 * first; expired and revoked ones collapse under Inactive.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { hasId, type MaybeConversationId } from "./conversation.js";
import { formatPreset, grantStatusLine, splitGrants, type Grant, type GrantVerb } from "./grants.js";
import { SourceBadge } from "./sourceIcon.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const POLL_MS = 30_000;
const BLOCKED_TITLE = "Only someone who could approve the original request can change this grant.";

function grantsUrl(baseUrl: string, conversationId: string): string {
  return `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/grants`;
}

/** The conversation's grants, polled, plus a refresh; `refreshKey` changes force a reload. */
function useGrants(conversationId: MaybeConversationId, baseUrl: string, refreshKey: unknown) {
  const [grants, setGrants] = useState<Grant[] | undefined>(undefined);
  const load = useCallback(async () => {
    if (!hasId(conversationId)) return;
    try {
      const r = await fetch(grantsUrl(baseUrl, conversationId), { credentials: "include" });
      if (r.ok) setGrants(((await r.json()) as { grants?: Grant[] }).grants ?? []);
    } catch {
      // Keep the last list; the next poll retries.
    }
  }, [conversationId, baseUrl]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load, refreshKey]);
  return { grants, reload: load };
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function GrantsPanel({
  conversationId,
  baseUrl,
  refreshKey,
}: {
  conversationId: MaybeConversationId;
  baseUrl: string;
  /** Reload when this changes, e.g. after an approval that may have granted something. */
  refreshKey?: unknown;
}) {
  const { grants, reload } = useGrants(conversationId, baseUrl, refreshKey);
  const now = useNow();
  const [showInactive, setShowInactive] = useState(false);
  if (grants === undefined) return null;
  const { active, inactive } = splitGrants(grants, now);

  const act = async (g: Grant, verb: string, minutes?: number): Promise<string | undefined> => {
    if (!hasId(conversationId)) return "This conversation has not started yet.";
    try {
      const r = await fetch(
        `${grantsUrl(baseUrl, conversationId)}/${encodeURIComponent(g.contrib)}/${encodeURIComponent(g.id)}/${encodeURIComponent(verb)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(minutes !== undefined ? { minutes } : {}),
        },
      );
      if (!r.ok) return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${r.status})`;
      return undefined;
    } catch {
      return "Could not reach the server.";
    } finally {
      await reload();
    }
  };

  return (
    <section className="mt-5 border-t pt-3" data-testid="grants-section" aria-label="Grants">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Grants</h3>
      {grants.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="grants-empty">
          No grants. Some approvals let the agent keep access for a while; those show here.
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">Active ({active.length})</p>
          {active.length === 0 && <p className="mb-2 text-sm text-muted-foreground">Nothing is granted right now.</p>}
          <ul className="flex flex-col gap-2" data-testid="grants-active">
            {active.map((g) => (
              <GrantRow key={`${g.contrib}/${g.id}`} grant={g} now={now} act={act} />
            ))}
          </ul>
          {inactive.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                data-testid="grants-inactive-toggle"
                aria-expanded={showInactive}
                onClick={() => setShowInactive(!showInactive)}
                className="-ml-1 flex items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showInactive ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                Inactive ({inactive.length})
              </button>
              {showInactive && (
                <ul className="mt-2 flex flex-col gap-2" data-testid="grants-inactive">
                  {inactive.map((g) => (
                    <GrantRow key={`${g.contrib}/${g.id}`} grant={g} now={now} act={act} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function GrantRow({
  grant: g,
  now,
  act,
}: {
  grant: Grant;
  now: number;
  act: (g: Grant, verb: string, minutes?: number) => Promise<string | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // The timed verb whose presets are showing.
  const [picking, setPicking] = useState<string | null>(null);
  const live = g.status === "active";

  const run = async (verb: string, minutes?: number) => {
    setBusy(true);
    setError(undefined);
    setPicking(null);
    setError(await act(g, verb, minutes));
    setBusy(false);
  };
  const picked = g.verbs.find((v) => v.verb === picking);
  // Pin rides Extend's presets as "Indefinite" when both are offered.
  const pin = g.verbs.find((v) => v.verb === "pin");
  const folded = pin && g.verbs.some((v) => v.verb === "extend");
  const shown = folded ? g.verbs.filter((v) => v !== pin) : g.verbs;

  return (
    <li
      className={cn("rounded-lg border p-2.5", live ? "bg-muted/40" : "bg-background opacity-80")}
      data-testid="grant"
      data-grant-id={g.id}
      data-status={g.status}
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0">
          <SourceBadge source={g.contrib} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug" data-testid="grant-title">
            {g.title}
          </p>
          <p
            className={cn("text-xs", live ? "text-foreground/80" : "text-muted-foreground")}
            data-testid="grant-status"
          >
            {grantStatusLine(g, now)}
            {g.granted_by && <span className="text-muted-foreground"> · granted by {g.granted_by}</span>}
          </p>
        </div>
      </div>
      {g.scope.length > 0 && (
        <ul className="mt-1.5 list-none text-xs text-muted-foreground" data-testid="grant-scope">
          {g.scope.map((s) => (
            <li key={s} className="truncate" title={s}>
              {s}
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {shown.map((v) => (
            <VerbButton
              key={v.verb}
              verb={v}
              busy={busy}
              open={picking === v.verb}
              onClick={() => (v.presets_minutes.length ? setPicking(picking === v.verb ? null : v.verb) : run(v.verb))}
            />
          ))}
        </div>
      )}
      {picked && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="grant-presets">
          {picked.presets_minutes.map((m) => (
            <Button
              key={m}
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy}
              data-testid="grant-preset"
              data-minutes={m}
              onClick={() => run(picked.verb, m)}
            >
              {formatPreset(m, picked.verb === "extend" ? "+" : "")}
            </Button>
          ))}
          {folded && picked.verb === "extend" && (
            <Button
              variant="secondary"
              size="sm"
              className={cn("h-7 px-2 text-xs", pin.allowed === false && "cursor-not-allowed")}
              disabled={busy || pin.allowed === false}
              title={pin.allowed === false ? BLOCKED_TITLE : undefined}
              data-testid="grant-preset"
              data-verb="pin"
              onClick={() => run("pin")}
            >
              Indefinite
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="mt-1.5 text-xs text-destructive" data-testid="grant-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function VerbButton({
  verb: v,
  busy,
  open,
  onClick,
}: {
  verb: GrantVerb;
  busy: boolean;
  open: boolean;
  onClick: () => void;
}) {
  const blocked = v.allowed === false;
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "h-7 px-2 text-xs",
        v.verb === "revoke" && "text-destructive hover:text-destructive",
        blocked && "cursor-not-allowed",
      )}
      disabled={busy || blocked}
      title={blocked ? BLOCKED_TITLE : undefined}
      aria-expanded={v.presets_minutes.length ? open : undefined}
      data-testid="grant-verb"
      data-verb={v.verb}
      onClick={onClick}
    >
      {v.label}
      {v.presets_minutes.length > 0 && <ChevronDown className="ml-0.5 size-3" aria-hidden />}
    </Button>
  );
}
