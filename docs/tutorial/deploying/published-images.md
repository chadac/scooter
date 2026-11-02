# Using the published images

This is the deployment most teams want: Scooter's CI builds and publishes every image to
`ghcr.io/chadac-me/scooter`, and you deploy them with your own configuration. You build
nothing yourself.

This page sets up a deployment repository that:

- renders the manifests on every pull request, so a broken config fails review,
- deploys to your cluster when a change merges, after checking every image exists, and
- opens a pull request each week to update Scooter.

## The deployment repository

```text
scooter-deploy/
├── flake.nix
├── flake.lock
├── scooter.nix
└── .github/workflows/
    ├── render.yml
    ├── deploy.yml
    └── update-scooter.yml
```

Start from the flake in [Getting started](../../getting-started.md) and add one output:
`image-refs`, the list of images the manifests name. The workflows below use it to check
that every image exists before deploying.

```nix
# flake.nix
{
  inputs = {
    scooter.url = "github:chadac-me/scooter";
    nixpkgs.follows = "scooter/nixpkgs";
    flake-parts.follows = "scooter/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = { system, pkgs, ... }:
        let
          platform = inputs.scooter.lib.evalPlatform {
            inherit system;
            module = ./scooter.nix;
          };
          images = builtins.attrValues platform.config.scooter.images;
        in {
          # nix build -> ./result, the manifests
          packages.default = platform.config.kubernetes.result;

          # nix build .#image-refs -> every image ref the manifests name, one per line
          packages.image-refs = pkgs.writeText "image-refs"
            (pkgs.lib.concatMapStrings (i: i.ref.fullUrl + "\n") images);
        };
    };
}
```

!!! warning "Changing Scooter's nixpkgs is at your own risk"
    `nixpkgs.follows = "scooter/nixpkgs"` points *your* flake at Scooter's nixpkgs, so you
    run exactly what Scooter's CI built and tested.

    You can go the other way and make Scooter use your nixpkgs
    (`scooter.inputs.nixpkgs.follows = "nixpkgs"`), for example to pick up a security fix
    sooner. Two things follow:

    - **None of the published images match any more.** A different nixpkgs changes every
      image's store hash, and so every tag. You have to build and publish your own images;
      see [Custom images](custom-images.md#build-your-own-images).
    - **Scooter is only tested against its own nixpkgs.** Before you deploy on another one,
      run the test suite against it in a checkout of Scooter:

        ```bash
        nix flake lock --override-input nixpkgs github:NixOS/nixpkgs/<rev>
        just ci     # what CI runs: flake checks, manifests, lint, unit tests
        just test   # the full suite: unit, cluster integration and end-to-end
        ```

        [`CONTRIBUTING.md`](https://github.com/chadac-me/scooter/blob/main/CONTRIBUTING.md)
        covers the setup and the individual test tiers.

## Deploy by hand once

Do the first deploy from your machine, so you can watch it.

1. **Create the namespace and Secrets.** Secret values never go into the manifests, so
   create every Secret your config refers to before you apply: the conversation signing
   key, plus one for each contrib, model provider or webhook that needs it.

    ```bash
    kubectl create namespace scooter
    kubectl -n scooter create secret generic agent-conv-token-secret \
      --from-literal=secret="$(openssl rand -hex 32)"
    ```

2. **Render, and check the images exist** (see [below](#check-the-images-exist)).

3. **Apply.** `nix build` writes `result` as a single JSON `List`. Apply the namespace and
   the CRD from it first, so nothing races them, then everything:

    ```bash
    nix build
    jq '{apiVersion: "v1", kind: "List", items: [.items[]
          | select(.kind == "Namespace" or .kind == "CustomResourceDefinition")]}' result \
      | kubectl apply --server-side -f -
    kubectl apply --server-side -f result
    kubectl -n scooter rollout status deploy/agent-host --timeout=5m
    ```

### Check the images exist

Rendering can't tell whether an image was published, so check before every apply. It
takes a few seconds, and it catches the main way a deploy goes wrong: tracking a Scooter
revision whose images CI hasn't finished publishing.

```bash
nix build .#image-refs -o image-refs
missing=0
while read -r ref; do
  if skopeo inspect --raw "docker://$ref" >/dev/null 2>&1; then
    echo "ok       $ref"
  else
    echo "MISSING  $ref"; missing=$((missing + 1))
  fi
done < image-refs
[ "$missing" -eq 0 ] || { echo "$missing image(s) not published"; exit 1; }
```

The images are public, so `skopeo` needs no login.

## Deploy from GitHub Actions

### Render on every pull request

This catches evaluation errors, such as a typo'd option or a contrib missing a required
setting, and image tags that aren't published, before anything reaches the cluster. It
needs no cluster credentials.

```yaml
# .github/workflows/render.yml
name: render
on:
  pull_request:
  push:
    branches: [main]

jobs:
  render:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: nixbuild/nix-quick-install-action@v30

      - name: render the manifests
        run: nix build -o manifests.json

      - name: check every image is published
        run: |
          nix build .#image-refs -o image-refs
          nix shell nixpkgs#skopeo -c bash -c '
            missing=0
            while read -r ref; do
              if skopeo inspect --raw "docker://$ref" >/dev/null 2>&1; then
                echo "ok       $ref"
              else
                echo "::error::not published: $ref"; missing=$((missing + 1))
              fi
            done < image-refs
            exit $missing'

      - uses: actions/upload-artifact@v4
        with:
          name: manifests
          path: manifests.json
```

### Deploy on merge

The deploy job runs the same checks, then applies. It needs credentials for your cluster.
This example reads a kubeconfig from a repository secret, `KUBECONFIG_B64`
(`base64 -w0 < kubeconfig`). Give that kubeconfig a service account limited to Scooter's
namespace, plus the cluster-scoped objects the manifests install: the CRD, and a few
ClusterRoles and their bindings.

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch: {}

# One deploy at a time; a newer push waits for the running one.
concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production   # optional: require an approval in Settings → Environments
    steps:
      - uses: actions/checkout@v5
      - uses: nixbuild/nix-quick-install-action@v30

      - name: render
        run: |
          nix build -o manifests.json
          nix build .#image-refs -o image-refs

      - name: check every image is published
        run: |
          nix shell nixpkgs#skopeo -c bash -c '
            missing=0
            while read -r ref; do
              skopeo inspect --raw "docker://$ref" >/dev/null 2>&1 \
                || { echo "::error::not published: $ref"; missing=$((missing + 1)); }
            done < image-refs
            exit $missing'

      - name: cluster credentials
        run: |
          mkdir -p ~/.kube
          echo "${{ secrets.KUBECONFIG_B64 }}" | base64 -d > ~/.kube/config
          chmod 600 ~/.kube/config

      - name: apply
        run: |
          nix shell nixpkgs#kubectl nixpkgs#jq -c bash -euo pipefail -c '
            jq "{apiVersion: \"v1\", kind: \"List\", items: [.items[]
                  | select(.kind == \"Namespace\" or .kind == \"CustomResourceDefinition\")]}" \
              manifests.json | kubectl apply --server-side -f -
            kubectl apply --server-side -f manifests.json
            kubectl -n scooter rollout status deploy/agent-host --timeout=5m'
```

On EKS, you can replace the kubeconfig secret with GitHub's OIDC: use
`aws-actions/configure-aws-credentials` with an IAM role the cluster maps to a Kubernetes
user, then `aws eks update-kubeconfig`. Then no long-lived credential is stored in GitHub.

Don't add a `kubectl rollout restart`. Content tags already roll exactly the Deployments
whose images changed, and a forced restart would interrupt running conversations on every
deploy, even when nothing changed.

### Update Scooter weekly

Upgrading Scooter means moving the `scooter` entry in `flake.lock`. This workflow does it
on a schedule and opens a pull request. The render workflow then checks the new images
exist, and merging deploys it.

```yaml
# .github/workflows/update-scooter.yml
name: update scooter
on:
  schedule:
    - cron: "0 9 * * 1"   # Mondays, 09:00 UTC
  workflow_dispatch: {}

permissions:
  contents: write
  pull-requests: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: nixbuild/nix-quick-install-action@v30
      - uses: DeterminateSystems/update-flake-lock@main
        with:
          inputs: scooter
          pr-title: "chore: update scooter"
          pr-labels: dependencies
```

Two things to know:

- **Pull requests opened with the default `GITHUB_TOKEN` don't trigger other workflows**,
  so the render check won't run on them. Pass a fine-grained personal access token or a
  GitHub App token as the action's `token` input.
- **Scooter publishes images when a commit lands on its `main`**, and the update can catch
  a commit whose images are still building. The image check on the pull request then
  fails. Re-run it a few minutes later.

<!-- TODO: vend these as reusable workflows / composite actions from chadac-me/scooter. -->

## Running on a Claude subscription

The `claude-code` provider needs the `agent-host-claude` image, which bundles the unfree
Claude Code CLI. Scooter can't yet select that image for you, so point `agent-host` at it
and pin its tag:

```nix
# scooter.nix
{ lib, ... }: {
  scooter.images.agent-host.ref = {
    image = "ghcr.io/chadac-me/scooter/agent-host-claude";
    tag = lib.mkOverride 20 "mk0ycrfj32cl";
  };
}
```

The tag changes whenever that image's contents do. To get the tag for the Scooter revision
in your `flake.lock`, compute it the way Scooter's CI does:

```bash
rev=$(jq -r .nodes.scooter.locked.rev flake.lock)
NIXPKGS_ALLOW_UNFREE=1 nix eval --impure --raw \
  "github:chadac-me/scooter/$rev#packages.x86_64-linux.agent-host-image-claude.outPath" \
  | xargs basename | cut -c1-12
```

Run it whenever you update Scooter. The image check can't catch a stale tag: an older tag
is still published, so it passes. Making this automatic is tracked in
[#824](https://github.com/chadac-me/scooter/issues/824).

<!-- TODO(#824): shrink this section to `scooter.images.agent-host.claude.enable = true` once published refs ship as data. -->
