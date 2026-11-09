/**
 * The deployment's contrib UI metadata (brand rows, tool cards, filter chips,
 * settings tabs, Approvals-tab cards, right-panel tabs, fenced-block renderers,
 * markdown syntax, views),
 * fetched at runtime from `/contrib/manifest.json`, which the UI's nginx serves from
 * the contrib set that deployment enabled. Loading never throws: a 404, a network
 * error, a timeout or a malformed body all mean "no contribs", and the app renders its
 * built-ins. Rows are validated one at a time, so one malformed row costs its own chip
 * rather than the whole manifest.
 */

import type {
  ContribApproval,
  ContribIcon,
  ContribInterruptRenderer,
  ContribManifest,
  ContribMarkdownFence,
  ContribMarkdownSyntax,
  ContribLinkView,
  ContribView,
  ContribPanel,
  ContribSettingsTab,
  ContribSource,
  ContribToolCard,
} from "./contribTypes.js";

/** Same-origin by construction — see the nginx route in services/ui/image/nginx.nix. */
const ENDPOINT = "/contrib/manifest.json";

/** main.tsx blocks the first paint on this fetch, so a hung route must degrade to
 *  built-ins rather than a blank page. */
const TIMEOUT_MS = 1500;

const EMPTY: ContribManifest = {
  sources: {},
  toolCards: {},
  toolTitles: {},
  linkProviders: [],
  approvals: {},
  settingsTabs: {},
  interruptRenderers: {},
  panels: {},
  markdownFences: {},
  markdownSyntax: {},
  linkViews: {},
  views: {},
};

let manifest: ContribManifest = EMPTY;

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asIcon(v: unknown): ContribIcon | undefined {
  const r = asRecord(v);
  return isStr(r.viewBox) && isStr(r.path) ? { viewBox: r.viewBox, path: r.path } : undefined;
}

function asSource(v: unknown): ContribSource | undefined {
  const r = asRecord(v);
  const icon = asIcon(r.icon);
  if (!icon || !isStr(r.label) || !isStr(r.color)) return undefined;
  return { label: r.label, color: r.color, icon, linkProvider: r.linkProvider === true };
}

function asToolCard(v: unknown): ContribToolCard | undefined {
  const r = asRecord(v);
  if (!isStr(r.provider) || !isStr(r.argKey) || !isStr(r.action)) return undefined;
  return { provider: r.provider, argKey: r.argKey, action: r.action };
}

/** An approval row; a partial row is dropped rather than defaulted, so the option
 *  stays live and the broker still enforces. */
function asApproval(v: unknown): ContribApproval | undefined {
  const r = asRecord(v);
  if (!isStr(r.gatedOption) || !isStr(r.blockedTitle) || !isStr(r.blockedHint)) return undefined;
  return { gatedOption: r.gatedOption, blockedTitle: r.blockedTitle, blockedHint: r.blockedHint };
}

/** A settings tab row. The id (its key) must be a URL slug and the entry must sit in
 *  its own contrib's ui/, so a bad row cannot route to another contrib's module. */
const TAB_ID = /^[a-z][a-z0-9-]*$/;
function asSettingsTab(id: string, v: unknown): ContribSettingsTab | undefined {
  const r = asRecord(v);
  if (!TAB_ID.test(id) || !isStr(r.contrib) || !isStr(r.label) || !isStr(r.entry)) return undefined;
  if (typeof r.order !== "number" || !Number.isFinite(r.order)) return undefined;
  if (!r.entry.startsWith(`${r.contrib}/ui/`)) return undefined;
  return { contrib: r.contrib, label: r.label, order: r.order, entry: r.entry };
}

/** An interrupt renderer row. The kind (its key) must sit in its contrib's namespace and the
 *  entry in its contrib's ui/, so a bad row cannot hijack another contrib's requests or module. */
const KIND = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/;
function asInterruptRenderer(kind: string, v: unknown): ContribInterruptRenderer | undefined {
  const r = asRecord(v);
  if (!KIND.test(kind) || !isStr(r.contrib) || !isStr(r.entry)) return undefined;
  if (!kind.startsWith(`${r.contrib}.`) || !r.entry.startsWith(`${r.contrib}/ui/`)) return undefined;
  return { contrib: r.contrib, entry: r.entry };
}

/** A panel row, keyed by its own contrib, so a bad row cannot load another contrib's module. */
function asPanel(contrib: string, v: unknown): ContribPanel | undefined {
  const r = asRecord(v);
  if (r.contrib !== contrib || !isStr(r.label) || !isStr(r.entry)) return undefined;
  if (typeof r.order !== "number" || !Number.isFinite(r.order)) return undefined;
  if (!r.entry.startsWith(`${contrib}/ui/`)) return undefined;
  return { contrib, label: r.label, order: r.order, entry: r.entry };
}

/** A fenced-block renderer row; the language is a slug and the entry sits in its contrib's ui/. */
const FENCE_LANG = /^[a-z][a-z0-9-]*$/;
function asMarkdownFence(lang: string, v: unknown): ContribMarkdownFence | undefined {
  const r = asRecord(v);
  if (!FENCE_LANG.test(lang) || !isStr(r.contrib) || !isStr(r.entry)) return undefined;
  if (!r.entry.startsWith(`${r.contrib}/ui/`)) return undefined;
  return { contrib: r.contrib, entry: r.entry };
}

/** A syntax row; the entry sits in its contrib's ui/. */
function asMarkdownSyntax(contrib: string, v: unknown): ContribMarkdownSyntax | undefined {
  const r = asRecord(v);
  if (!isStr(r.entry) || !r.entry.startsWith(`${contrib}/ui/`)) return undefined;
  return { entry: r.entry };
}

/** A link view row, keyed by its own contrib, with its entry in that contrib's ui/. */
function asLinkView(contrib: string, v: unknown): ContribLinkView | undefined {
  const r = asRecord(v);
  if (!isStr(r.entry) || !r.entry.startsWith(`${contrib}/ui/`)) return undefined;
  return { entry: r.entry };
}

/** A view row; the id is a slug and the entry sits in its contrib's ui/. */
const VIEW_ID = /^[a-z][a-z0-9-]{0,39}$/;
function asView(id: string, v: unknown): ContribView | undefined {
  const r = asRecord(v);
  if (!VIEW_ID.test(id) || !isStr(r.contrib) || !isStr(r.label) || !isStr(r.entry)) return undefined;
  if (typeof r.order !== "number" || !Number.isFinite(r.order)) return undefined;
  if (!r.entry.startsWith(`${r.contrib}/ui/`)) return undefined;
  return { contrib: r.contrib, label: r.label, order: r.order, entry: r.entry };
}

/** Keep the rows that validate, drop the ones that don't. */
function rows<T>(v: unknown, as: (x: unknown, key: string) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, raw] of Object.entries(asRecord(v))) {
    const row = as(raw, key);
    if (row) out[key] = row;
  }
  return out;
}

/** Validate a fetched document into the normalized manifest without ever throwing. */
function parse(doc: unknown): ContribManifest {
  const d = asRecord(doc);
  const sources = rows(d.sources, asSource);
  return {
    sources,
    toolCards: rows(d.toolCards, asToolCard),
    toolTitles: rows(d.toolTitles, (v) => (isStr(v) ? v : undefined)),
    approvals: rows(d.approvals, asApproval),
    settingsTabs: rows(d.settingsTabs, (v, id) => asSettingsTab(id, v)),
    interruptRenderers: rows(d.interruptRenderers, (v, kind) => asInterruptRenderer(kind, v)),
    panels: rows(d.panels, (v, contrib) => asPanel(contrib, v)),
    markdownFences: rows(d.markdownFences, (v, lang) => asMarkdownFence(lang, v)),
    markdownSyntax: rows(d.markdownSyntax, (v, contrib) => asMarkdownSyntax(contrib, v)),
    linkViews: rows(d.linkViews, (v, contrib) => asLinkView(contrib, v)),
    views: rows(d.views, (v, id) => asView(id, v)),
    // A link provider whose source row failed validation would be a chip with no
    // icon, so it is dropped too.
    linkProviders: (Array.isArray(d.linkProviders) ? d.linkProviders : []).filter(
      (p): p is string => isStr(p) && p in sources,
    ),
  };
}

/** Fetch the deployment's contrib manifest and populate the getters below, resolving
 *  even without a manifest because a deployment with no contribs is the normal case. */
export async function loadContribManifest(): Promise<void> {
  // Each load is authoritative: a 404 or an error means this deployment serves no contribs.
  manifest = EMPTY;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { cache: "no-store", signal: abort.signal });
    if (!res.ok) return;
    manifest = parse(await res.json());
  } catch {
    /* no manifest, no contribs — the app falls back to its own sources */
  } finally {
    clearTimeout(timer);
  }
}

/** Brand row per contrib, merged under the app's own sources (sourceIcon.tsx). */
export function contribSources(): Record<string, ContribSource> {
  return manifest.sources;
}

/** Tool-call message cards, keyed by tool name (toolCallView.ts). */
export function contribToolCards(): Record<string, ContribToolCard> {
  return manifest.toolCards;
}

/** registerTool titles accepted as a fallback -> the tool name they mean. */
export function contribToolTitles(): Record<string, string> {
  return manifest.toolTitles;
}

/** Sources offered as sidebar filter chips and "Show:" label modes (sessions.ts). */
export function contribLinkProviders(): readonly string[] {
  return manifest.linkProviders;
}

/** Approval gating per contrib name (InterruptPanel.tsx); absent means no gating. */
export function contribApprovals(): Record<string, ContribApproval> {
  return manifest.approvals;
}

/** Contrib settings tabs, keyed by tab id (SettingsPage.tsx). */
export function contribSettingsTabs(): Record<string, ContribSettingsTab> {
  return manifest.settingsTabs;
}

/** Contrib Approvals-tab cards, keyed by request kind (InterruptPanel.tsx). */
export function contribInterruptRenderers(): Record<string, ContribInterruptRenderer> {
  return manifest.interruptRenderers;
}

/** Contrib right-panel tabs, by contrib name. */
export function contribPanels(): Record<string, ContribPanel> {
  return manifest.panels;
}

/** Contrib fenced-block renderers, by fence language. */
export function contribMarkdownFences(): Record<string, ContribMarkdownFence> {
  return manifest.markdownFences;
}

/** Contrib markdown syntax modules, by contrib name. */
export function contribMarkdownSyntax(): Record<string, ContribMarkdownSyntax> {
  return manifest.markdownSyntax;
}

/** Contrib link views, by contrib name (LinkText.tsx). */
export function contribLinkViews(): Record<string, ContribLinkView> {
  return manifest.linkViews;
}

/** Contrib alternate views, by view id. */
export function contribViews(): Record<string, ContribView> {
  return manifest.views;
}
