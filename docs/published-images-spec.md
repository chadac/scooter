# Spec: ship published image refs as data, not as an eval

Status: proposed. Supersedes `ghcr-image-refs` and `scooter.images.<n>.refKey`.

## Problem

A deployer who just wants the published images still has to evaluate scooter's
flake. `ghcr-image-refs` looks like data but is a *derivation*: its content
comes from the `platformGhcr` render, so reading it pulls in nixpkgs, kubenix,
every image derivation and the whole module tree.

That eval is also how the refs get their tags, which means the tags are a
*prediction* of what CI pushed. The prediction is load-bearing and silent when
wrong: `publish-images.yml` recomputes the same hash independently, and if the
two ever disagree a deploy names a tag that was never pushed.

Then there is the naming. The `name -> packages attr` mapping is currently
written five times:

| where | form |
|---|---|
| `flake.nix` `imageMeta` | `agent-host.attr = "agent-host-image"` |
| `.github/scripts/k3d-platform-up.sh:163` | `push_attrs` bash array |
| `.github/workflows/publish-images.yml:59` | build matrix |
| `.github/workflows/publish-images.yml:167` | manifest matrix |
| `pkgs/*/image.nix` | `refKey = "agentHost"` |

`refKey` adds a second naming scheme on top (`agent-sandbox-ui` -> `ui`,
`agent-db-migrator` -> `dbMigrator`), mapped non-mechanically, for no reason
beyond the JSON's historical key shape.

## Design

CI writes the refs it actually pushed to a committed JSON file. A module reads
that file. No eval, no prediction, one naming scheme.

### The data file

`modules/data/published-images.json`, committed, written by `publish-images.yml`:

```json
{
  "schemaVersion": 1,
  "images": {
    "agent-host": { "image": "ghcr.io/chadac/scooter/agent-host", "tag": "xm52p76ya54k" },
    "agent-sandbox-os": { "image": "ghcr.io/chadac/scooter/agent-sandbox-os", "tag": "91815nwr4cry" }
  }
}
```

Keyed by canonical image name -- the same key `scooter.images.<name>` already
uses. `refKey` disappears. The shape matches `ref.{image,tag}` so the module is
a direct projection with no translation.

`schemaVersion` so a consumer pinning an older scooter fails loudly rather than
reading a renamed field as null.

### Variants

@chadac: "we would substitute the ghcrImage ref based on whether
claude.enable is true or not."

This is the case the file has to handle, and it breaks the one-ref-per-name
assumption. `agent-host` publishes TWO images -- `agent-host` and
`agent-host-claude` -- and `claude.enable` has to select the published ref, not
merely switch the local build. Today that is why server-config rebuilds the
image itself and hand-computes `claudeTag`.

@chadac: flat entries. So `agent-host-claude` is just another key, and the JSON
schema stays trivial -- every entry is `{ image, tag }`, no nesting:

```json
"agent-host":        { "image": "ghcr.io/chadac/scooter/agent-host",        "tag": "xm52p76ya54k" },
"agent-host-claude": { "image": "ghcr.io/chadac/scooter/agent-host-claude", "tag": "9f2bq1x7m4ck" }
```

The flag-to-key pairing then has to live somewhere, and the right place is the
image that already declares the flag. `pkgs/agent-host-image/image.nix` owns
`claude.enable`, so it also says which published key that selects:

```nix
config.scooter.images.agent-host = {
  imports = [{
    options.claude.enable = lib.mkEnableOption "bake the unfree claude CLI";
    # Which published entry claude.enable selects.
    options.publishedAs = lib.mkOption { type = lib.types.str; };
    config.publishedAs = lib.mkIf config.claude.enable "agent-host-claude";
  }];
};
```

The module then reads `publishedAs` (defaulting to the image's own name) rather
than knowing anything about claude:

```nix
scooter.images = mapAttrs (name: img: {
  ref.image = mkDefault published.images.${img.publishedAs}.image;
  ref.tag   = mkDefault published.images.${img.publishedAs}.tag;
}) cfg.images;
```

So no central list of variants, and a future variant on another image needs no
change here -- it declares its own `publishedAs`. This keeps the pairing in the
module system rather than in the JSON, which is the tradeoff flat buys: a
trivial schema in exchange for one option.

Note this reads an option to choose a definition for a sibling option on the
same submodule. That is the fixed point working as intended -- but a variant
flag must never be *defined* from the published data, or it self-references.

## Consequences

- `ghcr-image-refs` and `refKey` are deleted.
- `server-config` drops `ghcrRefsRaw`, `requireRef` (~25 lines, and its stale
  reference to scooter PR #315 as unmerged), `_module.args.images`, and all
  nine `images.*` assignments. It sets `useGhcrImages = true` plus
  `images.agent-host.claude.enable = true`.
- `imageMeta`, `push_attrs` and both CI matrices can read the same file,
  collapsing five lists to one.

## Ordering

`server-config` pins scooter by flake input, so this cannot be atomic:

- **A** (scooter): add the JSON, the module, the generator and the check.
  `ghcr-image-refs` and `refKey` stay, deprecated.
- **B** (server-config): relock, switch to `useGhcrImages`, delete the ref
  plumbing.
- **C** (scooter): delete `ghcr-image-refs` and `refKey`.

Deleting in A breaks the odin deploy at eval time.

## Decided

- **`scooter.useGhcrImages`**, not `images.fromPublished`. @chadac: "former is
  more readable."
- **Flat entries**, not nested variants. @chadac: "flat agent-host-claude."
  The flag-to-key pairing lives in the image's own `publishedAs` option.
- `agent-host-claude` is already published (`publish-images.yml:70`, with
  `unfree: true`), so the file can record it with no workflow change.
- **The PR check compares eval-vs-JSON; publish writes the file on merge.**
  @chadac: "compares eval vs. json on PRs" / "and then publishes."

### The lifecycle

Two jobs, two different roles, and conflating them is the trap:

| | compares | writes | when |
|---|---|---|---|
| PR check | eval vs. committed JSON | nothing | every PR |
| publish | nothing | the JSON | on merge to main |

**On a PR** the check regenerates from the local eval and diffs against the
committed file. It never consults the registry. A PR that changes an image
*should* show JSON churn -- the new tag is correct but not yet pushed, so a
registry comparison would fail every such PR for being correct. The author
commits the regenerated file along with the change.

**On merge** `publish-images.yml` pushes the images and writes the file back
with the tags it actually pushed, so main's JSON always describes real
registry contents. That write is also the backstop: if a PR's committed JSON
were somehow wrong, the publish run corrects it rather than leaving main
describing images nobody can pull.

Two consequences worth stating:

- The publish job needs write access to main (a commit, or a PR it
  auto-merges). A push to a protected main needs either a token that can
  bypass the branch rules or a bot PR -- open question (1).
- Eval and publish must compute the tag **identically**, and today they agree
  only by coincidence. `publish-images.yml:128` is
  `basename | cut -d- -f1 | cut -c1-12` (up to the first `-`, then 12 chars);
  `scooter.imagesContentTag` is `substring 0 12` (12 chars outright). Verified
  equal for agent-broker (`vjsngqa5hrdg` both ways), but they match only
  because a store hash is 32 chars with no `-` inside the first 12 -- a name
  whose hash portion were shorter would diverge.

  So the generator must call `imagesContentTag` and the workflow must consume
  the generator's output, rather than either reimplementing the slicing. Two
  independent formulas that happen to agree is precisely how the PR check
  starts passing on wrong data.

## Open questions

1. How does the publish job write to main -- a direct push with a token that
   bypasses branch protection, or a bot PR that auto-merges? Affects nothing
   about the design, but it is the one piece of plumbing with no obvious
   default.
2. Does the file record the multi-arch manifest tag only, or the per-arch
   `<tag>-<arch>` tags too? Deploys use the joined tag; nothing consumes the
   per-arch ones outside the workflow, so recording only the joined tag seems
   right -- but it means the file is written by the `manifest` job, not the
   per-arch build jobs.
