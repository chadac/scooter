/**
 * The shapes a contrib's UI metadata must satisfy, imported by both contribManifest.ts
 * (which validates a fetched document row by row against them) and the app modules
 * that merge the result in. The brand mark is SVG data rather than a react-icons
 * component because the manifest is fetched at runtime. Kept apart from sourceIcon.tsx
 * so that import stays acyclic. contrib/ui-manifest.nix generates the manifest and
 * contrib/submodule.nix (`ui`) holds the options a contrib writes.
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
 * How a contrib's approval interrupt is gated in the UI. Only the presentation half
 * lives here: where the contrib's verbs live on the broker is deployment config the
 * agent-host reads, and the browser is never told it.
 */
export interface ContribApproval {
  /** Which option id is greyed for a viewer the host says may not use it. */
  gatedOption: string;
  /** Tooltip on that option when it is greyed. */
  blockedTitle: string;
  /** Explanatory line shown under the options when it is greyed. */
  blockedHint: string;
}


/** A contrib's page under /settings, keyed by its id (the URL segment). */
export interface ContribSettingsTab {
  /** The contrib that declared it. */
  contrib: string;
  /** Sidebar label. */
  label: string;
  /** Sort key; the built-ins take 10, 20, … */
  order: number;
  /** `<contrib>/ui/<file>.tsx`, the key into the lazy module table (contribTabs.ts). */
  entry: string;
}

/** A contrib's card for one request kind in the Approvals tab, keyed by that kind. */
export interface ContribInterruptRenderer {
  /** The contrib that declared it. */
  contrib: string;
  /** `<contrib>/ui/<file>.tsx`, a key of contribTabs.tsx's module table. */
  entry: string;
}

/** A contrib's section in the Session tab, keyed by contrib name. */
export interface ContribPanel {
  /** The contrib that declared it. */
  contrib: string;
  /** Section label. */
  label: string;
  /** Sort key among contrib panels. */
  order: number;
  /** `<contrib>/ui/<file>.tsx`, the key into the lazy module table (contribTabs.tsx). */
  entry: string;
}

/** A contrib's renderer for one fenced code block language, keyed by that language. */
export interface ContribMarkdownFence {
  /** The contrib that declared it. */
  contrib: string;
  /** `<contrib>/ui/<file>.tsx`, the key into the lazy module table (contribTabs.tsx). */
  entry: string;
}


/** A contrib's `ui.markdownSyntax` row. */
export interface ContribMarkdownSyntax {
  /** `<contrib>/ui/<file>.tsx`, the key into the lazy module table (contribTabs.tsx). */
  entry: string;
}

/** A contrib's alternate view at `/<id>`, keyed by that id. */
export interface ContribView {
  /** The contrib that declared it. */
  contrib: string;
  /** Its name in the header's view switcher. */
  label: string;
  /** Sort key among contrib views in the switcher. */
  order: number;
  /** `<contrib>/ui/<file>.tsx`, the key into the lazy module table (contribTabs.tsx). */
  entry: string;
}

/** The whole `/contrib/manifest.json` document, normalized: the loader fills every
 *  absent key with an empty value, so consumers never branch on undefined. */
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
  /** Contrib settings tabs, keyed by tab id. */
  settingsTabs: Record<string, ContribSettingsTab>;
  /** Contrib interrupt renderers, keyed by request kind. */
  interruptRenderers: Record<string, ContribInterruptRenderer>;
  /** Contrib Session-tab sections, keyed by contrib name. */
  panels: Record<string, ContribPanel>;
  /** Contrib fenced-block renderers, keyed by fence language. */
  markdownFences: Record<string, ContribMarkdownFence>;
  /** Markdown syntax rows, by contrib name. */
  markdownSyntax: Record<string, ContribMarkdownSyntax>;
  /** Contrib alternate views, keyed by view id. */
  views: Record<string, ContribView>;
}
