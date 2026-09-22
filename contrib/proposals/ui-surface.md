# Proposal: a contrib contributes UI

**Status:** proposal, for review. No code. Background: #593 (the two closed
lists), #594 (shares, where the UI *is* most of the feature), #595 (why contrib
is the home for optional user-facing features).

A contrib today can contribute a broker provider and a webhooks handler. It
cannot contribute a single pixel. That is fine for a provider whose UI is one
row in an icon table; it blocks **static shares**, which is a `RightPanel` tab
plus two components plus an embed renderer.

## Two tiers, and only one of them is hard

**Tier 1 — metadata.** Pure data the app already keys off a hardcoded name:

- `ui/src/sourceIcon.tsx` — `SOURCES: Record<string, SourceMeta>`, a label, a
  brand icon and a brand colour per source.
- `ui/src/toolCallView.ts` — `type Provider = "slack" | "github" | "gitlab" |
  "jira"`, plus `BY_TOOL` / `BY_TITLE` mapping tool names to
  `{provider, argKey, action}` for the message-card rendering.

**Tier 2 — components.** A contrib ships real React: a panel, a tab, a custom
renderer. `RightPanel`'s `type Tab = "sandbox" | "approvals" | "queue" |
"subagents" | "shares"` is the closed union that has to open.

Everything the integrations need is tier 1. Shares and aws need tier 2.

## Why this must be build-time

The instinct is a runtime API — the UI asks the broker "which contribs are
enabled?" and renders accordingly. That cannot work here, for two independent
reasons:

1. **The icons are React components, not strings.** `sourceIcon.tsx` imports
   `SiGithub`, `SiGitlab`, `SiJira`, `FaSlack` individually, and says why:
   *"imported per-icon so only the ones we use are bundled."* A runtime manifest
   naming `"SiGrafana"` as a string would require bundling all of `react-icons`
   to be able to resolve it.
2. **The UI is a static `dist/`.** `ui/default.nix` is a `buildNpmPackage`
   producing a vite bundle. There is no server-side render and no module loader
   at runtime, so tier-2 components must be present when vite runs.

So discovery is a **generated package consumed at build time** — which is
exactly what the platform already does once: `lib/ts/scooter-schema` generates
`@scooter/schema` from `lib/sql`, and agent-host imports its typed tables *"so a
lib/sql column rename becomes a compile error here"*. This proposal is that
pattern with the evaluated contrib set (#585) as the input instead of `lib/sql`.

## Proposed schema

```nix
contribs.shares = {
  ui = {
    enable = true;

    # Tier 1: the source row (label + brand icon + colour).
    source = {
      label = "Shares";
      icon  = "FaShareNodes";   # resolved against a pinned icon set, see below
      color = "#4F46E5";
    };

    # Tier 1: how this contrib's tools render as message cards.
    tools = {
      publish_share = { argKey = "description"; action = "published a page"; };
    };

    # Tier 2: a RightPanel tab. `entry` is a module exporting a default component.
    panels = [{
      id = "shares";
      title = "Shares";
      entry = ./ui/SharesPanel.tsx;
    }];
  };
};
```

## The generated artifact

A derivation walks the enabled contrib set and emits `@scooter/contrib-manifest`:

```ts
// generated — do not edit
import { FaShareNodes } from "react-icons/fa6";
import SharesPanel from "@scooter/contrib-shares/SharesPanel";

export const sources = { shares: { label: "Shares", Icon: FaShareNodes, color: "#4F46E5" } };
export const toolCards = { publish_share: { provider: "shares", argKey: "description", action: "published a page" } };
export const panels = [{ id: "shares", title: "Shares", Component: SharesPanel }];
```

The app's own entries stay where they are and the generated ones merge on top —
so `SOURCES` becomes `{ ...builtins, ...manifest.sources }`, `type Provider`
becomes `string`, and `type Tab` becomes the base union plus
`manifest.panels[].id`. Both existing lookups are already `Record<string, …>`
with graceful fallbacks (#593), so a partially-populated manifest degrades
instead of breaking.

Symlinked into the UI's `node_modules` the way agent-host already consumes its
generated package, and type-checked at the consumption point so a contrib
declaring a tool that no longer exists is a build error rather than a silently
dead card.

**One manifest, two consumers.** agent-host's hardcoded `slack_respond` /
`github_comment` / … tool registrations (#593, surface 3) key off the same tool
names as `BY_TOOL`. agent-host already imports a generated package, so it should
consume this one too rather than get its own — otherwise the tool name, its
prompt text and its card metadata live in two generated artifacts that can
disagree.

## The constraint that shapes tier 2

`ui/default.nix` is `buildNpmPackage` with `src = ./.` and a **pinned
`npmDepsHash`**. If a tier-2 contrib may declare its own npm dependencies, then
adding a contrib changes the UI's lockfile and its hash — and "adding a contrib
is a new directory, no app edit" is false again, just relocated from
`sourceIcon.tsx` to `package-lock.json`.

Proposed rule: **a contrib's UI code composes only from a pinned surface** — an
`@scooter/ui-kit` re-exporting react, the design-system primitives the app
already uses, and the `react-icons` sets already in the bundle. No contrib-local
npm deps. The alternative (regenerate the lockfile per contrib set) makes the
UI's build inputs a function of the deployment's contrib selection, which is a
much larger change than the feature justifies.

That rule also settles the `icon` field: it is a name resolved against the
pinned icon sets, validated at generation time, not an arbitrary import.

## Open questions

- **Tab order.** `panels` from several contribs need a deterministic order —
  sort by contrib name, or an explicit `order` field?
- **Does a disabled contrib leave a dead tab?** It should not: `enable = false`
  means absent from the manifest, hence no tab, matching the existing "no
  derivation at all" semantics.
- **Does `type Provider` widening to `string` lose anything?** It is what
  unblocks contribs, but it removes exhaustiveness checking wherever the union is
  switched on. Worth auditing the consumers before committing to it.
- **Where does `scooter-publish.md` go?** Shares' skill doc sits in the app's
  flat `skills/` dir. That is a separate surface, proposed in
  `sandbox-image.md` — cross-referenced because shares needs both.

## Sequencing

Tier 1 alone makes the integrations self-contained and is the safer first step:
metadata only, no React from contribs, no `ui-kit` needed. Tier 2 lands with
shares, which is also when contrib-owned schema is needed (#594) — so tier 2
should not be the blocker for finishing the integrations.

## Where this doc should live

`docs/` is the user-facing mkdocs site and design docs are kept outside the repo
(AGENTS.md), so this sits next to the code it proposes changing. If proposals
belong outside the repo alongside `DESIGN.md`, drop the file and keep the
content in the PR description.
