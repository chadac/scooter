# Deploying Scooter

[Getting started](../../getting-started.md) ends with `nix build && kubectl apply -f result`
on your laptop. This section turns that into a deployment you can run for a team: rendered
and applied from CI, upgraded on a schedule, and, when you need it, running images you
build yourself.

## How a deployment works

A Scooter deployment is two things:

1. **Manifests**, rendered by your deployment flake from your `scooter.nix`. They're plain
   Kubernetes objects: Deployments, Services, RBAC, a CRD, ConfigMaps.
2. **Images**, which the manifests name. Every image ref carries a **content tag**, the
   first 12 characters of the image's Nix store hash:

    ```text
    ghcr.io/chadac-me/scooter/agent-broker:3mb12pgj38v5
    ```

### Content tags

Scooter's images are Nix derivations, and every derivation's store path starts with a
hash of **everything that goes into building it**: the source, every dependency down to
the compiler, and the build steps themselves. The tag is the first 12 characters of that
hash:

```text
/nix/store/3mb12pgj38v5…-image-agent-broker.json
           └──────────┘
ghcr.io/chadac-me/scooter/agent-broker:3mb12pgj38v5
```

So a tag changes exactly when something that goes into the image changes, and never
otherwise. That's what avoids unnecessary work at both ends:

- **No unnecessary rebuilds.** Nix computes the hash without building anything, so
  Scooter's CI works out each image's tag first and skips the build and push when the
  registry already has it. A commit that only touches the broker rebuilds only the broker.
- **No unnecessary restarts.** An image whose inputs didn't change keeps its tag, so its
  Deployment's spec is unchanged and `kubectl apply` leaves its pods running.

Compare the usual alternatives. Tagging with the git commit gives every image a new tag on
every commit, so everything rebuilds and every pod restarts, interrupting conversations.
Tagging with `latest` can't tell you what's running, and nodes may keep serving a stale
cached copy.

Your deployment computes the same tags while rendering, from the exact Scooter revision in
your `flake.lock`, without building or contacting a registry. Two consequences follow:

- **Only images someone has published are deployable.** Rendering always succeeds, but if
  nobody has pushed an image with that tag, its pods sit in `ImagePullBackOff`. Check before
  you apply; [Using the published images](published-images.md#check-the-images-exist)
  shows how.
- **Updates roll only what changed.** After a Scooter update, only the Deployments whose
  images have new tags restart.

Rendering never builds an image, so it's fast and works from any machine. That includes
macOS, because tags always come from the x86_64 build.

## Choose a path

| | Images come from | You need it when | Page |
|---|---|---|---|
| **Published images** | `ghcr.io/chadac-me/scooter`, built by Scooter's CI | Almost always: you configure Scooter but don't change its code | [Using the published images](published-images.md) |
| **Mirrored images** | your registry, copied unchanged from ghcr | Your cluster can't pull from ghcr.io, or policy requires an internal registry | [Custom images → Mirroring](custom-images.md#mirror-the-published-images) |
| **Your own images** | your registry, built from your fork | You've changed Scooter's code: your own contribs, sandbox packages, patches | [Custom images → Building](custom-images.md#build-your-own-images) |

Most of what feels like it needs a custom image doesn't. Skills, contrib settings, models,
sandbox sizes and webhooks are all deployment config. The agent can also install tools
into its own sandbox at runtime, and the warm store can pre-build common ones. You need
your own images only when the *code* in them changes.
