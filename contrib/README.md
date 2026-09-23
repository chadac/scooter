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

### Contributing to the sandbox image

A contrib can also layer a NixOS module into the agent's sandbox — packages,
systemd units, activation:

```nix
contribs.aws = {
  src = ./.;
  services.broker.enable = true;
  sandbox.module = ./sandbox.nix;    # a plain NixOS module
};
```

There is no separate schema for packages or services: a package is
`environment.systemPackages` inside that module, a daemon is a
`systemd.services.*`. There is no `mkIf` either — a disabled contrib is dropped
before its module is ever imported, so `enable = false` means absent from the
image, exactly as it already means absent from the services.

**The list is derived from this source tree, and that is the whole design.**
`contrib/sandbox-modules.nix` evaluates the contrib set and returns the enabled
contribs' modules; `modules/sandbox-os/contribs.nix` imports that. The in-pod
re-converge (`scooter-rebuild`) rebuilds from a *vendored copy of the repo*, so
it runs the same deriver over the same source and reaches the same answer —
nothing is threaded in, and nothing has to be carried across a switch. That is
also why the module must live in the repo, and why anything it refers to
relatively (`../../pkgs/…`) resolves identically on both sides.

That eval gets **`lib` and nothing else**. The service-side arguments
`contrib/default.nix` passes — `broker`, `webhooks`, `python3Packages`, the
surface libs — are built packages, and the pod has neither a flake nor a network
to produce them, so a sandbox half that reaches for one fails at eval. Keep the
sandbox module to `pkgs` and plain NixOS config; a contrib may still take those
args for its *service* half, which this eval never forces.

See `contrib/echo/sandbox.nix` for the reference, and the
`dev-env-contrib-sandbox` check for what is asserted.

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
    icon = ./icon.svg;                             # the brand mark, in this dir
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

**This is METADATA only.** A contrib shipping real React (a `RightPanel` tab, a
custom renderer) is a second tier that lands with the first feature needing one.

**Why it is served at runtime rather than compiled in.** The UI image is built
once and deployed to clusters whose contrib set differs, so baking the manifest
into the bundle would mean re-running vite for every deployment that enables a
different contrib. `/telemetry/config.json` already solves the same problem the
same way.

So `contrib/ui-manifest.nix` walks the enabled contribs and emits ONE JSON
document, which nginx serves at `/contrib/manifest.json` and the UI fetches on
load, merging it **on top of** its own entries. Changing a deployment's contrib
set relinks that file — the compiled bundle is untouched.

That is only possible because the icon is **data**: a `viewBox` and a single
`<path d=…>`, read out of the contrib's own `.svg`. A React component could only
be resolved from a runtime name by bundling a whole `react-icons` pack (~4.9 MB),
which is what forced the build-time manifest before. Simple Icons (CC0) is a
convenient source; drop the `.svg` in the contrib's directory and point `icon`
at it.

The fetch is forgiving by design: a 404, a timeout, a network error or a
malformed document all mean "no contribs", never a broken page. A deployment
that enables none gets `{}` and the app's built-in sources.

`npm run dev` and the Playwright fast stack serve no manifest, so contrib rows
are simply absent there — the same forgiving path, no special case. To see them
locally:

```
nix build .#contrib-ui-manifest
mkdir -p ui/public/contrib && cp result ui/public/contrib/manifest.json
```

`ui/public/contrib/` is gitignored: a committed copy is exactly the drift the
runtime manifest removes.

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
