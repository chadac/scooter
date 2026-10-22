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
  contrib.nix               # the DECLARATION: `contribs.<name>` (see schema below)
  deployment.nix            # optional: a KUBENIX module -> renders manifests/env
  sandbox.nix               # optional: a NIXOS module  -> goes into the sandbox-os image
  scooter_contrib_<name>/
    __init__.py             # neutral; imports NEITHER broker nor webhooks
    broker_provider.py      # imports broker.*  (only loaded in the broker image)
    webhooks_handler.py     # imports webhooks.* (only loaded in the webhooks image)
  sql/                      # optional: its OWN database (schema.sql + migrations/; see "Owning a database")
  ui/                       # optional: settings tabs, ui/*.tsx (see "Contributing UI")
  tests/
```

**One file per half, named for what is in it** — the three are not interchangeable,
and which eval reads which is the thing most easily got backwards:

| file | eval | declares / contributes |
|---|---|---|
| `contrib.nix` | every eval that reads the registry | `contribs.<name>`: `src`, `services.*`, `ui`, `skills`, `approvals`, `sandbox.module`, `db`. What the contrib **is**. |
| `deployment.nix` | kubenix, with `modules/platform.nix` | the manifests/env this deployment's `contribs.<name>.*` config renders |
| `sandbox.nix` | NixOS, via `pkgs/sandbox-os` (and the baked re-converge list) | packages, systemd units, activation — anything in the agent's sandbox image |

`deployment.nix` is a module in the **same eval** as `modules/platform.nix`, so it
reaches the whole `scooter.*` tree exactly as any other platform module does —
there is no registration step and nothing to list (#711). What it does *not* do is
declare options: a contrib's deployment options are declared by its `contrib.nix`,
under `contribs.<name>`, so one tree holds both halves of an integration. See
*Extending the preset* below.

`contrib.nix` is the one file that cannot do that, and that is why it is a separate
file rather than the top of `deployment.nix`: it is read by evals that have no
`scooter.*` tree at all — the package build, and the sandbox image *plus its in-pod
re-converge*, which runs with `lib` and no flake. A `scooter.broker.extraEnv`
definition there is "option does not exist" in two of the three (#615, #607) — which
is exactly the split: `contrib.nix` *declares* `contribs.<name>.siteUrl`, and
`deployment.nix` is what reads it and writes `scooter.broker.extraEnv`.

`contrib/aws` and `contrib/files` are the two contribs with all three — aws because
a grant needs a human and the sandbox needs the CLIs, files because the review
surface is split across both sides (a viewer in the sandbox, the annotation store
in the broker). `contrib/echo` has `contrib.nix` +
`sandbox.nix`, which was the whole shape of a contrib before the deployment half
existed (#607 added the sandbox half, #636 the deployment half three days later). A
contrib with only a deployment half is the common case — every broker integration.

**Rule: the top-level module stays import-light.** The service-coupled modules
import their host service (`broker.*` / `webhooks.*`), which is present at
runtime in that service's image. A contrib therefore declares **no** dependency
on `broker`/`webhooks` — doing so would create a build cycle, since a service
depends on the contribs injected into it. Whichever group a service loads pulls
in only the matching module; the other is never imported in that image.

## The contrib declaration (`contrib/<name>/contrib.nix`)

Each contrib is a **module**, and `contribs.<name>` is a typed submodule with a
preset of options — so the spec has defaults, a contrib declares only what it
actually needs, and adding a field to the spec no longer means editing every
contrib. The schema lives in `contrib/spec.nix` + `contrib/submodule.nix`, is
**`lib`-only** (nothing in it forces a derivation — the build is
`contrib/build.nix`, applied by `contrib/default.nix` where `pkgs` exists), and
`contrib/all-modules.nix` is every contrib plus that schema, as one module you can
import.

Its import list is **explicit** — a `readDir` made every eval walk the directory
and defeated Nix's import caching — so an entry is `./<name>/contrib.nix`. Adding a
contrib means adding it there; `just check-contrib-coverage` fails CI if you forget,
because an unimported contrib is never built and never tested.

`enable` stays the one switch, declared by the contrib like everything else about
it, and it decides what **ships** — not what is imported. `modules/platform.nix`
imports every contrib's two halves unconditionally, straight off this list, and a
disabled contrib is inert there because everything its halves render sits behind
their own `mkIf`. Configuring one you did not ship is still a loud error, but it
comes from `shipGate` in `modules/platform.nix` rather than from the option not
existing (#599, #719).

The image is the one reader that still needs the *filtered* set up front
(`contrib/sandbox-modules.nix`): the pod has no registry to gate against, and the
re-converge replays its module list by path.

```nix
{
  contribs.gitlab = {
    src = ./.;                          # the contrib's own directory
    services.broker.enable = true;      # which service image(s) it plugs into
    services.webhooks = {
      enable = true;
      pythonDeps = ps: [ ps.httpx ];    # extra deps for THIS half only
    };
    # version = "0.0.0";                # stamped on the built distribution
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
  sandbox.module = ./sandbox.nix;    # a plain NixOS module
};
```

A contrib may ship **only** a sandbox half: it needs no `services.*.enable`, and
no Python package is built for it. `contrib/aws/` was that example until #633 gave
it a broker half too; its sandbox module is still the worked one — the
`scooter-aws` CLIs, the `awscli2` stub and the `~/.aws/config` render, which
`modules/sandbox-os/carry-over.nix` carried until the surface existed. The
fixture `contrib/echo/` is sandbox-only.

There is no separate schema for packages or services: a package is
`environment.systemPackages` inside that module, a daemon is a
`systemd.services.*`. There is no `mkIf` either — a disabled contrib is dropped
before its module is ever imported, so `enable = false` means absent from the
image, exactly as it already means absent from the services.

**The list is derived from this source tree, at image build, and baked.**
`contrib/sandbox-modules.nix` evaluates the contrib set and returns the enabled
contribs' sandbox modules two ways: the paths `pkgs/sandbox-os` imports, and the
same files repo-relative. The second list is baked into the sandbox as the
re-converge's module list (`programs.scooterModule.extraReconvergeModuleFiles`),
so a self-modify replays those files from the *vendored copy of the repo* instead
of re-evaluating the registry in a pod that has neither a flake nor a network.
That is why the module must live in the repo, and why anything it refers to
relatively (`../../pkgs/…`) resolves identically on both sides. Why: #717.

That eval gets **`lib` and nothing else** — free now that the schema itself is
lib-only (#711). A sandbox half is still built in the pod on every self-modify,
where there is no network, so keep it to `pkgs` and plain NixOS config: anything
that fetches at eval time fails there and nowhere else.

See `contrib/aws/sandbox.nix` for the shipped one and `contrib/echo/sandbox.nix`
for the fixture (echo is `enable = false`, so it covers the disabled-contrib path
an enabled contrib cannot), and the `dev-env-contrib-sandbox` check for what is
asserted.

#### Embedding the conversation (`/chat/<id>`)

A web service the sandbox half serves can show the conversation beside itself by
embedding the UI's conversation subpage in an iframe:

```html
<iframe src="https://<host>/chat/<conversation-id>"></iframe>
```

`/chat/<id>` is that one conversation's thread, composer and pending approvals,
with no sidebar, right panel or settings. It is the real UI, so approvals, queued
messages and tool cards all work. Its header links to the full app
(`target=_top`), every other link opens in a new tab, and the page never switches to
another conversation. The main UI's header has the same page as **Pop out chat**.

Inside the pod, build the URL from `CONVERSATION_URL`'s origin and
`CONVERSATION_ID`. The browser loads it from the ingress like any other link, so
the sandbox proxies nothing.

**Only the conversation's own sandbox may frame it.** The UI sends
`Content-Security-Policy: frame-ancestors <scheme>://<label>.<sandboxDomain>` on
`/chat/<id>`, where `<label>` is the id's first 8 hex characters, and
`frame-ancestors 'none'` on every other UI route. A page on conversation A's origin
can't frame B's chat or the main app, and, being cross-origin, can't read the chat
it does frame. Without `ingress.sandboxDomain`, services share the UI's origin and
the subpage allows `'self'`. That is no weaker than before, since a same-origin
sandbox page can already act as the user. `pkgs/ui-image/check.nix` pins these
headers against the rendered nginx config.

### Contributing deployment config (`contrib/<name>/deployment.nix`)

The manifests an integration renders belong to the contrib as well — as a file the
platform finds by name. The options an operator *sets* are declared one file over,
in `contrib.nix`, so both halves of a contrib live under one name:

```nix
# contrib/aws/contrib.nix — the DECLARATION, read by every eval
{ lib, ... }:
{
  contribs.aws = {
    options.accounts = lib.mkOption { /* … */ };
    config = { src = ./.; services.broker.enable = true; /* … */ };
  };
}
```

```nix
# contrib/aws/deployment.nix — a kubenix module, nothing to register
{ config, lib, ... }:
let ccfg = config.contribs.aws; in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) { /* … */ };
}
```

**`contribs.<name>.enable` is the only gate.** It used to be two — one for "build
this" and one for "deploy this" — which meant every integration spelled its name
twice, in two different trees, and a deployment could set one and not the other. Now
shipping a contrib and configuring it are the same decision: `enable` (default true)
says whether this build contains the integration at all, and the config beside it is
what that integration is configured with.

**One half, one file, named for what is in it**: `deployment.nix` is the kubenix module,
`sandbox.nix` the NixOS module baked into the agent's image, `contrib.nix` the
declaration both of them hang off. `contrib/aws` ships all three, and they are not
interchangeable — the names are what keep a reader from reaching for the wrong one.
A contrib with only a deployment half still gets its own `deployment.nix`, even when
that is two options and one env entry.

`modules/platform.nix` imports it, so it reads its own config
(`config.contribs.aws.*`) and renders its own `kubernetes.resources`. It
reaches a service's existing Deployment through that service's seams rather than
redeclaring the container:

| what it needs to add | the seam |
|---|---|
| env on the broker container | `scooter.broker.extraEnv` |
| a mounted ConfigMap | `broker.extraVolumes` + `broker.extraVolumeMounts` |
| a rollout when its config changes | `broker.podAnnotations` (hash the ConfigMap) |
| an IRSA / cloud identity annotation | `broker.serviceAccountAnnotations` |
| anything of its own | `kubernetes.resources.*` directly |

Found beside the declaration, not declared: `modules/platform.nix` derives the
list from `contrib/all-modules.nix` — each entry's `contrib.nix` plus the
`deployment.nix` next to it where one exists — so adding an integration still edits
no platform file, and there is no `deployment.module` left to keep in sync with the
filename.

It is a **static** list, with no pre-eval of the registry. The platform's `imports`
still cannot read `config.contribs` (`imports` resolves first, so that is `infinite
recursion encountered`, which `tryEval` does not catch — #615), but it no longer
needs to: it imports everything, and `enable` gates rendering instead of importing.
Until #719 a separate lib-only `evalModules` existed purely to apply that filter.

`just check-contrib-coverage` fails CI on a stray `.nix` in a contrib directory,
which is the typo this convention would otherwise swallow.

Nothing here may force a derivation: an external deployer imports `modules/platform.nix`
with no `pkgs` to build a contrib's Python half with, and a manifest needs none.

Three consequences worth knowing:

- **A deployment half is optional.** `skills` gates on `contribs.<name>.enable`
  (below), which every contrib has from the preset, so a contrib can ship skills with
  no `deployment.nix` at all. That used to throw: the gate was an option only
  `deployment.nix` could declare.
- **Configuring a contrib this build does not ship fails the render.** The options
  exist — every contrib is imported — so the error comes from `shipGate` in
  `modules/platform.nix`, which throws from a leaf every render produces. That is
  `enable` doing its job, and `examples/check.nix` asserts it in both directions:
  unshipping a contrib the example configures must fail, and unshipping one it does
  not must still render. Dropping a contrib therefore means dropping its config too —
  `contribs.<name> = lib.mkForce { enable = false; }` replaces the whole tree, which
  is the shape the check's own renders use.
- **A contrib READING a sibling's config has the mirror problem.** A platform module
  may touch any part of the tree — the module system has no notion of ownership. But
  `config.contribs.kagi.apiKeySecret` resolves only where kagi was also built, so a
  bare cross-contrib reference breaks every image that ships one without the other.
  You *can* work around it (guard with `?`); prefer not needing to. A constraint that
  wants two contribs in scope at once either belongs in the platform module, or — as
  the brave/kagi search exclusivity turned out to be — should not exist. Why: PR #707.

**`contrib/aws` is the worked example**, and it is worth reading as a pair:
`contrib.nix` declares the seven options (`accounts`, `region`, `externalId`,
`brokerPrincipalArn`, `serviceAccountRoleArn`, `roleTtlHours`, `approverClaim`), and
`deployment.nix` turns them into the account-registry ConfigMap, the `AWS_*` env, the
rollout annotation and the IRSA annotation — ~40 references inside
`modules/broker.nix` before #599, and a second option tree before this.

`examples/kubenix-config.nix` is the worked example from the *operator's* side: it
configures every shipped contrib under `contribs.*`, and `examples/check.nix`
asserts it still covers all of them.

`modules/broker.nix` declares only the broker's OWN options (`enable`, `image`,
`testProvider`, `agentHostUrl`, `extraEnv`, `extraVolumes`, `extraVolumeMounts`,
`podAnnotations`, `serviceAccountAnnotations`, `mcp`, `shares`, `fga`); no
integration's options live there, and nothing under `scooter.broker` is named after
a contrib.

Only the BROKER has these seams today. Adding them to another service is a
`bcfg.extraEnv`-shaped option plus one `++` in that service's module; a contrib's
platform module is not per-service, so nothing about it changes when they exist.

### Contributing agent skills (`skills`)

A contrib documents itself. The `.md` the agent reads lives next to the code it
describes, and ships only where that code is actually wired:

```nix
contribs.aws = {
  src = ./.;
  skills."scooter-aws.md" = ./skills/scooter-aws.md;
};
```

**The gate is `contribs.<name>.enable`** — a skill ships iff the contrib is
*built*, so no image carries instructions for code it does not contain. Deployment
config does not gate it: an agent should know an integration's interface even where
this deployment has not wired the credential, and a 404 then means "not enabled
here", which is the broker's answer to give rather than a gap in the agent's
knowledge.

That gating is the point, not bookkeeping. A skill for a provider that isn't
wired teaches the agent to call a route that 404s — and then to read that 404 as
the feature being *broken*, which is how the grafana skill once sent an agent
chasing a `loki/` path that never existed. `scooter-aws.md` shipped into every
deployment, aws or not, until this moved.

`modules/platform.nix` reads the set straight off `config.contribs`, filtered on
`enable` — the contribs are modules in its own eval (#711), so there is no second
module system to re-derive it from and nothing that could disagree with the build.
`examples/check.nix` renders the platform with each gate on and off and
asserts the file follows — and fails if a contrib ships a skill that table
doesn't cover. Skills that document the *platform* (`scooter-github.md`,
`sandbox-shell-safety.md`) stay in the top-level `skills/`: they document no
contrib, and there is nothing to gate them on.

### Contributing skill directories (`skillDirs`)

Some skills are a directory, not a file: a `SKILL.md` with `scripts/` and
`reference/` beside it, which is the shape `npx skills add` installs. Skill
directories are a platform feature (`skillDirs`, in `modules/skills/`). A
deployment can declare them without any contrib. A contrib only adds entries,
with the same shape, and they're added only when the contrib is enabled:

```nix
contribs.marimo = {
  # Pinned in modules/skills/skills.lock by `just lock-skills`; never a rev here.
  skillDirs.marimo-pair = {
    source = "github:marimo-team/marimo-pair";
    dir = "skills/marimo-pair";
  };
  # …or a directory in this contrib:
  # skillDirs.my-skill.path = ./skills/my-skill;
};
```

Like a contrib's `skills` files, the agent gets them only with
`scooter.agent.builtinSkills` on. How a directory is split between the agent and
the sandbox, and why a `source` is pinned in a lock rather than in the
declaration, is documented in `modules/skills/default.nix`.

- `just lock-skills` pins any source that has no entry yet. `--update` re-pins
  every source to its default branch's HEAD.
- `just check-skill-lock` (part of `just ci`) fails on a missing, stale or
  orphaned pin. A render with a missing pin throws and names the fix.
- Every contrib's sources are pinned, enabled or not, so shipping a contrib never
  needs a lock change.
- Names are global, like tool names. Two contribs declaring one name, or a name
  that is both a `skills` file and a `skillDirs` entry, fails the eval.

`contrib/echo/skills/echo-skill` is the fixture. `examples/check.nix` asserts the
agent half (gated, frontmatter first, note present, unpinned source fails, a
deployment-level entry ships), and `dev-env-contrib-sandbox` asserts the sandbox
half (installed whole, baked copy identical, re-declaring module present).

### Contributing agent tools (`mcp_tools.py`)

A contrib owns the agent's typed tools for its integration. Declare them on your
own `FastMCP` server and hand it to the broker as a transport:

```python
mcp = FastMCP(name="brave")

@mcp.tool
async def brave_web_search(query: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search the web with Brave and get ranked results."""
    ...

# broker_provider.py
transports=[McpTools(server=mcp, upstream="https://api.search.brave.com")]
```

The input schema comes from the type hints and the description from the
docstring; `ctx` is dependency-injected, which also keeps it out of the schema —
an argument the model could supply would be forgeable. `ctx.upstream` issues the
request with the provider's credential injected on the way out, so the agent
never holds the secret. `contrib/echo/scooter_contrib_echo/mcp_tools.py` is the
worked reference and `scooter_broker_lib/mcp.py` the surface.

**A tool ships iff its provider is enabled**, the same gate `skills` uses and for
the same reason: a tool for an integration that isn't wired teaches the agent to
call something that fails, and then to read that failure as the feature being
broken. For a keyed provider that gate is usually the key itself — no key, no
provider, no tool — which is how a deployment with no search key ends up with no search
tool at all rather than one that answers every query with nothing.

**TOOL NAMES ARE FLAT AND THEREFORE GLOBAL.** The servers are mounted
namespace-less, because the skills name these tools and
`ui/src/toolCallView.ts` matches on the name. So a name is an identity, and two
providers claiming one leaves nothing to arbitrate but mount order — the broker
refuses to start on a duplicate (`broker/mcp/routes.py`).

**So name a tool for its provider whenever a sibling contrib could offer the same
capability** — `brave_web_search` and `kagi_web_search`, not one shared
`web_search`. This is the convention the reply tools already follow
(`slack_respond`, `github_comment`), and the reason is sharper than consistency: a
shared name would make the two providers MUTUALLY EXCLUSIVE, which is a
restriction invented by the naming and not by anything about search. A deployment
that wants both an independent crawl and a human-ranked index should get two
tools and let the agent choose. Give a tool a bare, unprefixed name only when it
is the only thing of its kind the platform will ever have.

Then say in the DOCSTRING how it differs from its siblings and when to prefer it:
with two search tools listed, that docstring is all the agent has to choose on.

A reply tool for an attachable resource should also be **attachment-gated** with
`@gate`, so it is unlisted in a conversation it could not act in. Search needs no
gate: there is no resource to be attached to.

### Extending the preset

A contrib declares its **own** options by using the strict module form; they merge
into its config tree, and `config` is its own:

```nix
{
  contribs.jira = { config, lib, ... }: {
    options.siteUrl = lib.mkOption { type = lib.types.str; };
    config.services.broker.enable = true;
  };
}
```

**This is where every deployment option lives** — not an edge case. The preset in
`contrib/submodule.nix` covers what a contrib *is* (`src`, `services`, `ui`,
`skills`, `approvals`, `sandbox`); anything an operator configures is declared here,
by the contrib that reads it. That split is also what `shipGate` keys on: the preset's
fields are the contrib declaring itself, so only the options a contrib added of its
own count as deployment config, and setting one on a contrib this build does not ship
fails the render.

Nest only where the API being configured is nested — `tokenSecret.{name,key}` is a
Secret reference, so it is one option with two fields. Do not re-state the contrib
name inside its own tree: `contribs.github.appId`, never
`contribs.github.app.appId`, because `contribs.github` already said which app.

The file itself is a top-level module, so the **parent** config — every other
contrib — is available as its `config` argument. Bind it with
`let parent = config; in` if you also take the submodule's own `config`, since
the inner name shadows the outer one.

### Owning a database (`db`)

A contrib that owns tables gets its **own Postgres database** rather than adding
tables to its host service's. Its DDL and its Atlas migration history then live in
the contrib, so a contrib's schema change never adds a migration to a core
database:

```nix
contribs.files.config = {
  db.enable = true;                 # database `contrib_files` (override: db.name)
  db.tables.annotations = { };      # writers default to the services it plugs into
};
```

```
contrib/files/sql/
  schema.sql                        # end-state DDL — edit HERE
  migrations/                       # `just db-migrate <name>` writes these
```

From that declaration `modules/contrib-db.nix` derives the rest. The contrib's own
files never write `scooter.db.*` or `scooter.postgres.*`:

- the `scooter.db.contrib_<name>` spec entry (owners.toml, an atlas.hcl env whose
  paths point into `contrib/<name>/sql`);
- the database itself, `CREATE DATABASE … OWNER <host>`. **Roles stay per
  service**: a contrib in the broker connects as `broker`, with no user or Secret
  of its own;
- the migrator env (`DB_ENVS` gets `contrib_<name>:<host role>`), with the `sql/`
  dir bundled into the migrator image;
- `CONTRIB_<NAME>_DB_NAME` on the host pod.

The store connects with `ctx.contrib_store_config("<name>")`, which is the broker's
`store_config` pointed at the contrib's database. Core's generated bindings
(`scooter_schema`, `@scooter/schema`) skip contrib databases, because core must not
know contribs exist. The contrib keeps its own row model, and a
`tests/test_schema_matches.py` holds it to `sql/schema.sql`.

**Moving an existing table out of a core database.** Set
`db.tables.<t>.copyFrom = "<old db>"`. After migrating, the migrator copies the old
rows in once, matched on the primary key so rows written during the rollout do not
block it. Each deployment then drops the old table by setting
`scooter.dbMigrate.retireCopiedTables = true`: the migrator checks that every old
primary key is in the new database, drops the old table, and fails the job instead
if any row is missing. Once every deployment has set it, remove the old table
declaration and `copyFrom` together.

**Another contrib's data.** Go through the owning contrib's Python store (a
`pythonDeps` dependency, as below), never its SQL. There are no foreign keys
across databases, and a table read by a second service is not supported yet.

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

`enable` defaults to true as soon as `source`, `tools` or `settingsTabs` is set,
so a declared row cannot silently render nothing.

#### Settings tabs (`ui.settingsTabs`)

A contrib can add a page under `/settings`, written in React:

```nix
ui.settingsTabs = [{
  label = "Personalization";
  order = 50;                    # built-ins take 10, 20, … 50; ties sort by id
  entry = "ui/SettingsTab.tsx";  # relative to this contrib's directory
}];
```

- **Id and URL.** A tab's id defaults to the contrib name, so the usual single tab
  lives at `/settings/<name>`. A second tab sets `id`, and every id must be the
  contrib name or start with `<name>-`, which keeps contribs from colliding.
  `contrib/settings-tabs.nix` throws at eval on a bad or duplicate id, a clash with a
  built-in tab, or an `entry` that does not exist.
- **Where the code lives.** Every tab file is `contrib/<name>/ui/*.tsx`, directly in
  `ui/` (sibling files there are fine to import). `just check-contrib-coverage` fails
  on a `.tsx` anywhere else in a contrib, because the build, the type-check and the
  lint only see that glob.
- **The module.** Its default export is a React component with no props. It may
  import only `@/src/contrib/sdk`, `@/components/*`, `@/lib/*` and the packages in
  `ui/package.json`; `just lint` (ESLint, `ui/eslint.config.js`) rejects anything
  else. If a tab needs something from the app, add it to `ui/src/contrib/sdk.ts`.
  Need a new npm package? Add it to `ui/package.json`, the single lockfile.
- **How it ships.** Tabs are compiled into the main UI bundle as lazy chunks
  (`ui/src/contribTabs.tsx`), and the runtime manifest's `settingsTabs` section
  decides which appear. A disabled contrib's chunk is in the bundle but never
  fetched. A tab that fails to load or throws shows an error card in that tab only.

`contrib/echo/ui/SettingsTab.tsx` is the minimal example. To see a tab under
`npm run dev`, enable its contrib and copy the manifest as shown below.

Other React a contrib might ship (a `RightPanel` tab, a custom message renderer) is
not supported yet; it lands with the first feature that needs it.

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

`contrib/build.nix` builds each contrib ONCE PER TARGET SERVICE — each variant
depending only on that service's extension surface, so a both-services contrib
cannot put the webhooks surface on the broker's path. `contrib/default.nix` buckets
those into the per-service lists the flake injects. `fastapi` is already available
in both services.

It is plain Nix over the evaluated spec rather than a `package` option, and that
is deliberate: an option would make the schema take `python3Packages` and the
surface libs as module args, which the kubenix eval and the in-pod re-converge have
no way to supply. The schema stays lib-only; only this file resolves a derivation
(#711).

`enable = false` means ABSENT, the way it does in NixOS: no derivation
is produced and nothing in any build artifact comes from it. `echo` is disabled
because its provider is unconditionally enabled, so shipping it would serve
`/echo/ping` from a production broker.

Something that must be built anyway turns it back on with a config override
instead of `enable` meaning something softer. CI does exactly that, because an
untested reference implementation rots the moment a surface changes:

```nix
# flake.nix — reachable only from packages/checks, never from a service image
contribsWithExamples = contribs.withModules [{ contribs.echo.enable = lib.mkForce true; }];
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
