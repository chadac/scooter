# Contrib modules

A **contrib** is a self-contained package that adds an integration to Scooter
through **entry points** — never by editing a service's core. Each contrib can
plug into one or more services:

| Service    | Entry-point group           | Registry                     |
|------------|-----------------------------|------------------------------|
| `broker`   | `agent_broker.providers`    | `scooter_broker_lib/registry.py` |
| `webhooks` | `scooter_webhooks.handlers` | `scooter_webhooks_lib/registry.py` |

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
  module.nix                # Nix descriptor (see schema below)
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

## `module.nix` schema

Each contrib is a **module**, and `contribs.<name>` is a typed submodule with a
preset of options — so the spec has defaults, a contrib declares only what it
actually needs, and adding a field to the spec no longer means editing every
contrib. The schema lives in `contrib/options.nix` + `contrib/submodule.nix`;
`contrib/all-modules.nix` is every contrib plus that schema, as one module you
can import.

```nix
{
  contribs.gitlab = {
    src = ./.;                          # the contrib's own directory
    services.broker.enable = true;      # which service image(s) it plugs into
    services.webhooks = {
      enable = true;
      pythonDeps = ps: [ ps.httpx ];    # extra deps for THIS half only
    };
    # ship = false;                     # build + test it, but never ship it
    # enable = false;                   # do not build it at all
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
services.webhooks.pythonDeps = ps: [ ps.scooterContribJira ];
```

Declaring it under `services.webhooks` is what keeps the closures apart: only
gitlab's webhooks half needs jira, and declaring it for both halves would drag
jira into the broker variant's closure — the surface leak the per-service split
exists to stop.

`ps` holds THIS service's variant of each contrib, so a dep cannot pull the wrong
surface in, and a typo is an eval error rather than a `ModuleNotFoundError` at
service startup. Contribs are prefixed `scooterContrib<Name>` because a bare
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

### What the framework does with it

`contrib/submodule.nix` builds each contrib ONCE PER TARGET SERVICE — each
variant depending only on that service's extension surface, so a both-services
contrib cannot put the webhooks surface on the broker's path — and exposes it as
`contribs.<name>.services.<svc>.package`. `contrib/default.nix` buckets those
into the per-service lists the flake injects. `fastapi` is already available in
both services.

`ship = false` marks reference material: it is still built and its tests still
run (`nix build .#contrib-echo`), but it is left out of what ships. `echo`'s
provider is unconditionally enabled, so shipping it would serve `/echo/ping`
from a production broker.

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
