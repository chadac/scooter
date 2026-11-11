/**
 * FoldedContent — a collapsed region whose content stays in the DOM. Closed, it carries
 * `hidden="until-found"` (content-visibility: hidden, no layout, no paint), so the
 * browser's find-in-page still matches the text inside: a match fires `beforematch` on
 * the region, which calls `onReveal` so the owner opens the fold onto it. A browser
 * without until-found treats the value as plain `hidden`, so the fold is just collapsed
 * there.
 *
 * Tool cards use this (ToolCallView.tsx, tool-fallback.tsx) so a shell command's output
 * or a tool's arguments are out of the way, but Ctrl-F still finds them.
 */

import { useEffect, useLayoutEffect, useRef, type ComponentProps } from "react";

export type FoldedContentProps = ComponentProps<"div"> & {
  open: boolean;
  /** The browser revealed the content for a find-in-page match: set `open` to true. */
  onReveal: () => void;
};

export function FoldedContent({ open, onReveal, children, ...rest }: FoldedContentProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;

  // React serialises `hidden` as a boolean, so the until-found value goes on the node
  // after each render: a closed fold renders `hidden=""` first (never a flash of open
  // content), then upgrades to until-found. When the browser reveals the region itself it
  // drops the attribute, and `open` turning true keeps React's view of the prop in step.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "until-found");
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reveal = () => onRevealRef.current();
    el.addEventListener("beforematch", reveal);
    return () => el.removeEventListener("beforematch", reveal);
  }, []);

  return (
    <div ref={ref} hidden={!open} data-state={open ? "open" : "closed"} {...rest}>
      {children}
    </div>
  );
}
