/**
 * A private conversation's visibility menu: whether it acts as its owner, who keeps it from
 * doing so, and the owner's "Clear taint" and "Make shared" actions.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Lock, LockOpen, ShieldAlert, ShieldCheck } from "lucide-react";
import { Popover } from "radix-ui";

import { clearConversationTaint, getConversationTaint, type TaintView } from "./client.js";
import { agentHostConfig } from "./config.js";
import { clearTaintWarning, serverIdOf, toggleVisibility } from "./sessionActions.js";
import type { Session } from "./sessions.js";
import { Button } from "@/components/ui/button";

type Load = { state: "loading" } | { state: "failed" } | { state: "loaded"; view: TaintView };

/** The taint panel's body: status, reasons and clear action. */
export function TaintStatus({ load, busy, onClear }: { load: Load; busy: boolean; onClear: () => void }) {
  if (load.state === "loading") return <p className="text-muted-foreground">Checking who wrote here…</p>;
  if (load.state === "failed") return <p className="text-muted-foreground">Couldn't check who wrote here. Credentials stay off until it can.</p>;
  const { authors } = load.view;
  if (authors.length === 0) {
    return (
      <p data-testid="taint-clean" className="flex gap-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <span>Acts as you: your SSH key, commit identity and forge tokens.</span>
      </p>
    );
  }
  const labels = [...new Set(authors.map((a) => a.label))];
  return (
    <div data-testid="taint-reasons" className="flex flex-col gap-2">
      <p className="flex gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>Doesn't use your credentials, because someone else wrote text here:</span>
      </p>
      <ul className="ms-6 list-disc text-muted-foreground">
        {labels.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <Button data-testid="taint-clear" variant="outline" size="sm" disabled={busy} onClick={onClear} className="self-start">
        Clear taint…
      </Button>
    </div>
  );
}

/** A private conversation's lock button, or a caller-anchored panel. */
export function PrivacyPopover({
  session: s,
  open: openProp,
  onOpenChange,
  anchor,
}: {
  session: Session;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchor?: ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const id = serverIdOf(s);

  const refresh = useCallback(async () => {
    if (!id) return;
    const view = await getConversationTaint(agentHostConfig, id);
    setLoad(view ? { state: "loaded", view } : { state: "failed" });
  }, [id]);
  useEffect(() => {
    if (!open) return;
    setLoad({ state: "loading" });
    void refresh();
  }, [open, refresh]);

  const clear = async () => {
    if (!id || load.state !== "loaded") return;
    // Clears only what the confirm showed; later text still taints.
    const shown = load.view.authors;
    if (!window.confirm(clearTaintWarning(shown.map((a) => a.label)))) return;
    // Disabling the focused button would let the composer close us.
    content.current?.focus();
    setBusy(true);
    const view = await clearConversationTaint(agentHostConfig, id, shown);
    setBusy(false);
    setLoad(view ? { state: "loaded", view } : { state: "failed" });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {anchor ? (
        <Popover.Anchor className="flex">{anchor}</Popover.Anchor>
      ) : (
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="session-visibility"
            aria-label={`Privacy of ${s.title}`}
            aria-pressed
            title="Private: only you can see it"
            className="text-muted-foreground"
          >
            <Lock />
          </Button>
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Content
          ref={content}
          tabIndex={-1}
          data-testid="privacy-panel"
          align="end"
          sideOffset={6}
          className="z-50 flex w-80 flex-col gap-3 rounded-md border bg-popover outline-none p-3 text-sm text-popover-foreground shadow-md"
        >
          <p className="flex items-center gap-2 font-medium">
            <Lock className="size-4 text-muted-foreground" />
            Private: only you can see it
          </p>
          <TaintStatus load={load} busy={busy} onClear={() => void clear()} />
          <div className="h-px bg-border" />
          <Button
            data-testid="privacy-make-shared"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => {
              setOpen(false);
              void toggleVisibility(s);
            }}
          >
            <LockOpen />
            Make shared
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
