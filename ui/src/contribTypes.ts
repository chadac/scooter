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
 * The whole `/contrib/manifest.json` document, NORMALIZED: the loader fills every
 * absent key with an empty value, so consumers never branch on undefined. Any of
 * the four keys may be missing from the served document.
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
}
