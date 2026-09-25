/**
 * The shapes a contrib's UI metadata must satisfy.
 *
 * Hand-written and imported by BOTH sides: contribManifest.ts (which validates a
 * fetched document row by row against these) and the app modules that merge it
 * in. Separate from sourceIcon.tsx only to keep that import acyclic.
 *
 * The brand mark is SVG DATA, not a react-icons component: the manifest is
 * fetched at runtime, and a component named by a string could only be resolved
 * by bundling a whole react-icons pack. Why: PR #601.
 *
 * See contrib/ui-manifest.nix for what generates the manifest, and contrib/
 * submodule.nix (`ui`) for the options a contrib actually writes.
 */

/** A brand mark as raw data: one SVG path, drawn in the source's color. */
export interface ContribIcon {
  viewBox: string;
  /** The `d` of a single <path>. */
  path: string;
}

/** A source's row in the UI's provider table: label + brand mark. */
export interface ContribSource {
  label: string;
  icon: ContribIcon;
  /** Official brand color, or `currentColor` to inherit the theme. */
  color: string;
  /** Offer this source as a sidebar filter chip / "Show:" label mode. */
  linkProvider?: boolean;
}

/** How one agent tool renders as a message card. */
export interface ContribToolCard {
  /** The source whose brand row the card wears — a contrib name. */
  provider: string;
  /** Which tool argument holds the text to show. */
  argKey: string;
  /** Short verb for the card header, e.g. "commented on GitLab". */
  action: string;
}

/**
 * How a contrib's approval interrupt is GATED in the UI.
 *
 * Only the presentation half lives here. The browser is deliberately not told where
 * the contrib's verbs are on the broker — that travels to the agent-host, which does
 * the relaying. A UI that knew the broker path would be a UI that could be pointed at
 * one. Both halves are rendered from a single declaration (contrib/approvals.nix), so
 * the greying and the relay cannot end up describing different things — the split that
 * caused PR #649's split-brain authorization. Why: PR #651.
 */
export interface ContribApproval {
  /** Which option id is greyed for a viewer the host says may not use it. */
  gatedOption: string;
  /** Tooltip on that option when it is greyed. */
  blockedTitle: string;
  /** Explanatory line shown under the options when it is greyed. */
  blockedHint: string;
}

/**
 * The whole `/contrib/manifest.json` document, NORMALIZED: the loader fills every
 * absent key with an empty value, so consumers never branch on undefined. Any of
 * the keys may be missing from the served document.
 */
export interface ContribManifest {
  /** Brand row per contrib name. */
  sources: Record<string, ContribSource>;
  /** Tool-call message cards, keyed by tool name. */
  toolCards: Record<string, ContribToolCard>;
  /** registerTool titles (already lowercased) -> the tool name they mean. */
  toolTitles: Record<string, string>;
  /** Sources offered as sidebar filter chips and "Show:" label modes. */
  linkProviders: readonly string[];
  /** Approval gating per contrib name (the `metadata.contrib` on the interrupt). */
  approvals: Record<string, ContribApproval>;
}
