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
broker.claude.enable is true or not."

This is the case the file has to handle, and it breaks the one-ref-per-name
assumption. `agent-host` publishes TWO images -- `agent-host` and
`agent-host-claude` -- and `claude.enable` has to select the published ref, not
merely switch the local build. Today that is why server-config rebuilds the
image itself and hand-computes `claudeTag`.

So an entry carries its variants:

```json
"agent-host": {
  "image": "ghcr.io/chadac/scooter/agent-host",
  "tag": "xm52p76ya54k",
  "variants": {
    "claude": { "image": "ghcr.io/chadac/scooter/agent-host-claude", "tag": "9f2bq1x7m4ck" }
  }
}
```

and the module picks:

```nix
scooter.images = mapAttrs (name: img:
  let v = if (cfg.images.${name}.claude.enable or false) then img.variants.claude else img;
  in { ref.image = mkDefault v.image; ref.tag = mkDefault v.tag; })
  published.images;
```

Note this reads an option (`claude.enable`) to choose a definition for a
sibling option on the same submodule. That is the fixed point working as
intended -- no ordering concern -- but it does mean a variant flag must never
be *defined* from the published data, or it self-references.

Open question (5): `variants` as an open attrset keyed by flag name is general,
but nothing else has a variant today. The alternative is a flat second entry
(`"agent-host-claude": {...}`) plus the module knowing the name pairing. The
nested form keeps the pairing in data; the flat form keeps the schema trivial.
Leaning nested, since the flat form resurrects exactly the kind of implicit
name mapping `refKey` was.

### The module

`modules/published-images.nix`:

```nix
scooter.useGhcrImages = mkEnableOption "pin every image to the last published ref";

config = mkIf cfg.useGhcrImages {
  scooter.images = mapAttrs (_: img: {
    ref.image = mkDefault img.image;
    ref.tag   = mkDefault img.tag;
  }) (importJSON ./data/published-images.json).images;
};
```

`mkDefault`, so an explicit per-image override still wins -- a deployer can pin
ten images from the file and build the eleventh locally.

Open question (1): should this live at `scooter.useGhcrImages`, or as
`scooter.images.fromPublished = true`? The latter keeps image concerns under
`images`, but reads oddly as a verb.

### The PR check

The whole design rests on the JSON matching what the flake would build, so it
needs the `db-generate-check` treatment -- regenerate, diff, fail with
instructions:

```
published-images-check:
    scripts/published-images-generate.sh
    @git diff --exit-code -- modules/data/published-images.json \
      || (echo "❌ published-images.json drift: an image changed without regenerating. Run 'just published-images-generate' and commit." && exit 1)
```

CAUTION, learned the hard way: `just db-generate-check` and `check-lockfiles`
both *modify the working tree* as a side effect. Running this locally to
"just check" will rewrite the JSON. The generate script must be pure
(eval + write) with no network, so a dirty tree is the only failure mode.

Open question (2): the check regenerates from the LOCAL eval, so it proves
"the JSON matches what this tree would build" -- not "these tags exist in
ghcr". Those differ on any PR that changes an image: the new tag is correct but
unpublished until merge. So the check must compare against the eval, not the
registry, and the JSON is understood as "what main's images hash to", refreshed
by the publish workflow on merge. A PR that changes an image will show JSON
churn, which is the intended signal.

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

## Open questions

1. `scooter.useGhcrImages` or `scooter.images.fromPublished`?
2. Confirm the check compares eval-vs-JSON, never JSON-vs-registry (above).
3. Does the file record the multi-arch manifest tag only, or the per-arch
   `<tag>-<arch>` tags too? Deploys use the joined tag; nothing consumes the
   per-arch ones outside the workflow, so recording only the joined tag seems
   right -- but it means the file cannot be written until the `manifest` job.
4. `agent-host-claude` is already published (`publish-images.yml:70`, with
   `unfree: true`), so the file can record it today -- no workflow change for
   the unfree gate. Confirmed, not open.
5. `variants` nested vs. a flat second entry -- see Variants above.
