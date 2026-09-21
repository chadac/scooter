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

A thin, declarative descriptor read by `contrib/default.nix`:

```nix
{
  name = "echo";                  # package = scooter-contrib-<name>, import = scooter_contrib_<name>
  services = [ "broker" "webhooks" ];  # which service image(s) to inject into
  pythonDeps = ps: [ ];           # optional extra Python deps beyond the host service's
  example = true;                 # optional: build + test it, but never ship it
  contribDeps = { webhooks = [ "jira" ]; };  # optional: other contribs this one uses,
                                  # PER SERVICE (see below)
}
```

### Depending on another contrib

Integrations reference each other — gitlab reads Jira keys out of MR titles to
attach an MR to the conversation that ticket already opened — so `contribDeps`
is allowed and expected.

It is keyed **by service**: only gitlab's webhooks half needs jira, and a flat
list would drag jira into the broker variant's closure, which is the surface
leak the per-service split exists to stop.

Depend on the smallest thing that does the job: jira exports its issue-key
grammar as a pure-text module (no settings, no store, no routes), so the
dependency costs a regex. Note that installing a contrib makes its ENTRY POINTS
discoverable, so a service that ships gitlab also mounts jira's route — inert
unless jira is enabled, but present.

A dependency CYCLE is an eval-time infinite recursion in `contrib/default.nix`,
not a runtime bug. If two contribs genuinely need each other, move the shared
part into a third package rather than breaking the cycle with a late import.

`contrib/default.nix` builds each contrib ONCE PER TARGET SERVICE — each variant
depending only on that service's extension surface, so a both-services contrib
cannot put the webhooks surface on the broker's path — and buckets them by
`services`. The flake injects the per-service subset via each service's
`contribs` argument. `fastapi` is already available in both services.

`example = true` marks reference material: it is still built and its tests still
run (`nix build .#contrib-echo`), but it is left out of what ships. `echo`'s
provider is unconditionally enabled, so shipping it would serve `/echo/ping`
from a production broker.

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
