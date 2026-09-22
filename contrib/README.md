# Contrib modules

A **contrib** is a self-contained package that adds an integration to Scooter
through **entry points** — never by editing a service's core. Each contrib can
plug into one or more services:

| Service    | Entry-point group           | Registry                     |
|------------|-----------------------------|------------------------------|
| `broker`   | `agent_broker.providers`    | `scooter_broker_lib/registry.py` |
| `webhooks` | `scooter_webhooks.handlers` | `scooter_webhooks_lib/registry.py` |

A contrib also contributes **UI metadata** — its brand row and tool cards — which
reaches the frontend through a generated manifest rather than an entry point,
because the UI is a compiled static bundle. See [Contributing UI](#contributing-ui-ui).

At startup each service scans its group, loads every advertised factory (which
self-registers via `@register_provider` / `@register_webhook`), and mounts what
it discovers. Adding an integration is a new `contrib/<name>/` directory — no
edit to `app.py`, the broker core, or the flake's service definitions.

See `contrib/echo/` for the reference implementation that plugs into **both**
services.

## Layout

```
contrib/<name>/
  pyproject.toml            # package + entry points (both groups if it spans services); hatchling backend
  default.nix               # the contrib MODULE (see schema below)
  scooter_contrib_<name>/
    __init__.py             # neutral; imports NEITHER broker nor webhooks
    broker_provider.py      # imports broker.*  (only loaded in the broker image)
    webhooks_handler.py     # imports webhooks.* (only loaded in the webhooks image)
  tests/
```

**Rule: the top-level module stays import-light.** The service-coupled modules
import their host service (`broker.*` / `webhooks.*`), which is present at
runtime in that service's image. A contrib therefore declares **no** dependency
on `broker`/`webhooks` — doing so would create a build cycle, since a service
depends on the contribs injected into it. Whichever group a service loads pulls
in only the matching module; the other is never imported in that image.

## The contrib module (`contrib/<name>/default.nix`)

Each contrib is a **module**, and `contribs.<name>` is a typed submodule with a
preset of options — so the spec has defaults, a contrib declares only what it
actually needs, and adding a field to the spec no longer means editing every
contrib. The schema lives in `contrib/options.nix` + `contrib/submodule.nix`;
`contrib/all-modules.nix` is every contrib plus that schema, as one module you
can import.

Its import list is **explicit** — a `readDir` made every eval walk the directory
and defeated Nix's import caching — and since each contrib is a directory whose
module is its `default.nix`, an entry is just `./<name>`. Adding a contrib means
adding it there; `just check-contrib-coverage` fails CI if you forget, because an
unimported contrib is never built and never tested.

```nix
{
  contribs.gitlab = {
    src = ./.;                          # the contrib's own directory
    services.broker.enable = true;      # which service image(s) it plugs into
    services.webhooks = {
      enable = true;
      pythonDeps = ps: [ ps.httpx ];    # extra deps for THIS half only
    };
    # enable = false;                    # absent from the build entirely
    # version = "0.0.0";
  };
}
```

`services` has a **fixed** set of keys (`broker`, `webhooks`), so
`services.brokr.enable = true` is an eval error naming the option rather than a
variant that silently never gets built. A contrib that needs no extra deps says
nothing about them.

### Extending the preset

A contrib can declare its **own** options by using the strict module form; they
merge into its config tree, and `config` is its own:

```nix
{
  contribs.jira = { config, lib, ... }: {
    options.siteUrl = lib.mkOption { type = lib.types.str; };
    config.services.broker.enable = true;
  };
}
```

The file itself is a top-level module, so the **parent** config — every other
contrib — is available as its `config` argument. Bind it with
`let parent = config; in` if you also take the submodule's own `config`, since
the inner name shadows the outer one.

### Depending on another contrib

Integrations reference each other — gitlab reads Jira keys out of MR titles to
attach an MR to the conversation that ticket already opened — so depending on
another contrib is allowed and expected. There is no separate field for it:
`pythonDeps` is handed a package set that already contains every contrib, so one
option covers both "a library from nixpkgs" and "another contrib".

```nix
services.webhooks.pythonDeps = ps: [ ps.scooterContrib.jira ];
```

Declaring it under `services.webhooks` is what keeps the closures apart: only
gitlab's webhooks half needs jira, and declaring it for both halves would drag
jira into the broker variant's closure — the surface leak the per-service split
exists to stop.

`ps` holds THIS service's variant of each contrib, so a dep cannot pull the wrong
surface in, and a typo is an eval error rather than a `ModuleNotFoundError` at
service startup. Contribs are prefixed nested under `scooterContrib` because a bare
`ps.jira` would shadow nixpkgs' own `python3Packages.jira`. Only contribs that
target the service appear, so depending on one that does not is a
missing-attribute error.

Depend on the smallest thing that does the job: jira exports its issue-key
grammar as a pure-text module (no settings, no store, no routes), so the
dependency costs a regex. Note that installing a contrib makes its ENTRY POINTS
discoverable, so a service that ships gitlab also mounts jira's route — inert
unless jira is enabled, but present.

A dependency CYCLE is an eval-time infinite recursion, not a runtime bug. If two
contribs genuinely need each other, move the shared part into a third package
rather than breaking the cycle with a late import.

### Contributing UI (`ui`)

A contrib also owns its row in the frontend — the brand label/icon/color shown
for its linked resources, and how its agent tools render as message cards. These
used to be hardcoded lists in `ui/src/`, so adding an integration meant editing
the app and disabling one left a dead chip behind.

```nix
ui = {
  source = {
    label = "GitLab";
    icon = { pack = "si"; name = "SiGitlab"; };   # react-icons/si -> SiGitlab
    color = "#FC6D26";                             # or "currentColor"
    linkProvider = true;                           # offer a sidebar filter chip
  };
  tools.gitlab_comment = {
    argKey = "body";                               # which arg holds the text
    action = "commented on GitLab";
    titles = [ "Comment on the GitLab MR" ];       # registerTool title fallback
  };
};
```

`enable` defaults to true as soon as `source` or `tools` is set, so a declared
row cannot silently render nothing.

#### Panels (real React)

A contrib can also contribute a **right-panel tab**:

```nix
ui.panels = [{
  id = "shares";
  title = "Shares";
  entry = ./ui/SharesPanel.tsx;   # exports usePanel()
  order = 50;                      # among contrib tabs; ties break on id
}];
```

The entry module exports **one hook**:

```tsx
export const usePanel: ContribPanel["usePanel"] = () => {
  const { shares, configured } = useShares();
  return { show: configured, count: shares.length, body: <SharesList shares={shares} /> };
};
```

One hook rather than a component plus a separate badge selector, because a panel
with a subscription would otherwise open it twice — once for the tab's count,
once for the body. `show: false` hides the tab entirely, which is how a feature
whose backend is not wired in this deployment stays invisible instead of
offering an empty tab. `body` is an element, not a component, so re-renders
reconcile in place rather than remounting.

**A panel may import only `@scooter/ui-kit`** (`ui/src/uiKit.ts`) — React's
hooks, the conversation store, the design-system primitives, and
`agentHostGet` for reading the contrib's own agent-host route. It is an alias,
not an npm package, for the same `npmDepsHash` reason as the icon packs. Reach
past it with a relative import and you are coupling to app internals that are
free to change; widen the kit instead, which is a reviewed edit.

**The two generated modules are deliberately separate.** `contribManifest.
generated.ts` holds metadata; `contribPanels.generated.ts` holds panels. Merging
them closes an import cycle — a panel imports `@scooter/ui-kit`, which re-exports
the session store, which reads the metadata manifest — and the symptom is a TDZ
error at module init, not a compile failure.

**Still out of reach:** a contrib cannot yet contribute a custom message-content
renderer (shares' `scooter-embed` block is still app-side), and cannot add npm
dependencies at all.

**Why it is generated at build time rather than served at runtime.** Two
independent reasons, both in `ui/src/sourceIcon.tsx`: the icons are React
components imported *per-icon* "so only the ones we use are bundled", so a
runtime manifest naming `"SiGitlab"` as a string could only resolve by bundling
all of `react-icons`; and the UI is a static vite `dist/` with no module loader,
so anything a contrib contributes must exist when vite runs.

So `contrib/ui-manifest.nix` walks the enabled contribs and emits a source
**overlay** for `ui/src/`: the two generated modules, plus a copy of each panel's
source under `contrib/<name>/`. The app merges the metadata **on top of** its own
entries. The overlay is committed — that is what makes `npm run dev`, `vitest`
and a plain `npm run build` work without nix — and `just contrib-ui-check` fails
CI on drift. A deployment with a different contrib set never reads the committed
copy: `ui/default.nix` replaces the whole overlay with its own.

Panel sources are **copied** rather than resolved by alias because a deployment's
contribs live outside this repo entirely; an alias would have to point somewhere
different in-tree and out, and that divergence would only show up in the
deployment that matters.

After changing any `ui` option:

```
nix develop -c just contrib-ui-generate   # then commit the result
```

Two constraints worth knowing. The icon `pack` is a **fixed enum**
(`contrib/ui-icon-packs.nix`) because a contrib cannot add an npm dependency —
`ui/default.nix` pins `npmDepsHash`, so a contrib-local dep would change the
UI's lockfile and make "adding a contrib is a new directory" false again, just
relocated. And the icon `name` is only shape-checked in Nix; its **existence**
is checked by `tsc` when the UI compiles the manifest, so a typo is a build
error rather than a missing glyph.

### What the framework does with it

`contrib/submodule.nix` builds each contrib ONCE PER TARGET SERVICE — each
variant depending only on that service's extension surface, so a both-services
contrib cannot put the webhooks surface on the broker's path — and exposes it as
`contribs.<name>.services.<svc>.package`. `contrib/default.nix` buckets those
into the per-service lists the flake injects. `fastapi` is already available in
both services.

`enable = false` means ABSENT, the way it does in NixOS: no derivation is
produced and nothing in any build artifact comes from it. `echo` is disabled
because its provider is unconditionally enabled, so shipping it would serve
`/echo/ping` from a production broker.

Something that must be built anyway turns it back on with a config override
instead of `enable` meaning something softer. CI does exactly that, because an
untested reference implementation rots the moment a surface changes:

```nix
# flake.nix — reachable only from packages/checks, never from a service image
contribsWithExamples = contribs.withModules [{ contribs.echo.enable = true; }];
```

Because `tests/` is shared by both variants, every enabled service's
`pythonDeps` are check inputs for *each* variant — a webhooks-only test still has
to import in the broker variant. Check-only, so it never widens the runtime
closure.

## Discovery is dual-source (and will become entry-point-first)

Both registries load from **two** sources through one code path: a built-in
`pkgutil` scan of the in-tree `providers/` / `handlers/` package **and** the
entry-point group above. The built-in scan is what lets integrations migrate
into `contrib/` one at a time while the service stays green.

The intended end state is **entry-point-first**: every integration ships as a
contrib package, and the in-tree scan is retired (or kept for dev only). Because
both sources already funnel into the same `@register_*` + factory contract,
that migration only moves *where* a handler is declared — the registry, the
`enabled` semantics, and the discovery loop stay exactly as they are today.
