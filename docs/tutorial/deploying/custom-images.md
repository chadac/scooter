# Custom images

There are two reasons to run images other than the ones on `ghcr.io/chadac-me/scooter`:

- **Your cluster must pull from your own registry**, but the images can stay as published.
  [Mirror them](#mirror-the-published-images): copy the published images into your
  registry, unchanged. No builds.
- **You've changed what goes into the images**: your own
  [contribs](../writing-a-contrib/index.md), extra packages in the sandbox image, a patch,
  or a [different nixpkgs](published-images.md#the-deployment-repository).
  [Build your own](#build-your-own-images) from a fork.

Both keep the same tags, so the rest of the deployment from
[Using the published images](published-images.md) carries over: the same flake, image
check and workflows.

## Mirror the published images

### 1. Point the manifests at your registry

`scooter.registryPrefix` is prepended to every image name. The tags don't change.

```nix
# scooter.nix
scooter.registryPrefix = "123456789012.dkr.ecr.us-east-1.amazonaws.com/scooter/";
```

With that prefix, the UI and broker images in the rendered manifests change like this:

```text
# default
ghcr.io/chadac-me/scooter/agent-sandbox-ui:zvyycww2x1gj
ghcr.io/chadac-me/scooter/agent-broker:3mb12pgj38v5

# with the prefix above
123456789012.dkr.ecr.us-east-1.amazonaws.com/scooter/agent-sandbox-ui:zvyycww2x1gj
123456789012.dkr.ecr.us-east-1.amazonaws.com/scooter/agent-broker:3mb12pgj38v5
```

The prefix replaces everything before the image name, and the tag stays the same, so a
mirror copies each image under its original tag. Every other image follows the same
pattern; `nix build .#image-refs` lists them all.

`image-refs` now lists your registry, so the image check verifies your mirror instead of
ghcr.

### 2. List what to copy

Add an output that pairs each image's ghcr source with its destination in your registry:

```nix
# flake.nix, next to image-refs
packages.image-mirror = pkgs.writeText "image-mirror"
  (pkgs.lib.concatStrings (pkgs.lib.mapAttrsToList
    (name: i: "ghcr.io/chadac-me/scooter/${name}:${i.ref.tag} ${i.ref.fullUrl}\n")
    platform.config.scooter.images));
```

```text
ghcr.io/chadac-me/scooter/agent-broker:3mb12pgj38v5 123456789012.dkr.ecr.us-east-1.amazonaws.com/scooter/agent-broker:3mb12pgj38v5
…
```

### 3. Copy before you deploy

`skopeo copy --all` copies both architectures, and skips layers the destination already
has. Run it as a step in `deploy.yml`, before the image check:

```yaml
      - name: mirror images
        run: |
          nix build .#image-mirror -o image-mirror
          nix shell nixpkgs#skopeo -c bash -euo pipefail -c '
            while read -r src dst; do
              skopeo copy --all --retry-times 3 "docker://$src" "docker://$dst"
            done < image-mirror'
```

Log in to your registry first. For ECR, use `aws-actions/configure-aws-credentials` and
then `aws ecr get-login-password | skopeo login --username AWS --password-stdin <registry>`.
ECR also needs a repository created for each image name before the first push.

For the claude-code provider, mirror `agent-host-claude` too, and point
`scooter.images.agent-host.ref.image` at your copy (see
[Running on a Claude subscription](published-images.md#running-on-a-claude-subscription)).

### Pull credentials

If your registry needs credentials, give them to the pods. Create a
`kubernetes.io/dockerconfigjson` Secret (for example with
`kubectl create secret docker-registry regcred …`), then reference it from two places in
`scooter.nix`:

```nix
let pullSecrets = [ { name = "regcred"; } ]; in
{
  # Every Deployment and Job the platform renders.
  kubernetes.api.defaults = [
    { kind = "Deployment"; default.spec.template.spec.imagePullSecrets = pullSecrets; }
    { kind = "Job"; default.spec.template.spec.imagePullSecrets = pullSecrets; }
  ];

  # Every sandbox pod the agent-host creates at runtime.
  scooter.deployTools.sandboxManifestOverlay.spec.podTemplate.spec.imagePullSecrets =
    pullSecrets;
}
```

The first is plain kubenix: a default applied to every resource of that kind. The second is
merged into each conversation's Sandbox when the agent-host creates it.

**The warm store is the exception.** Its controller creates Jobs at runtime, and neither
setting reaches them. One of those Jobs also pulls `busybox:1.36` from Docker Hub, which
the mirror list doesn't include. With `scooter.warmStore.enable`, configure pull
credentials on the nodes instead:

- **EKS with ECR:** the node role's `AmazonEC2ContainerRegistryReadOnly` policy covers it,
  and covers everything else too, so on EKS you may not need a pull Secret at all.
- **k3s:** add the registry and its credentials to `/etc/rancher/k3s/registries.yaml` on
  every node.
- **Other clusters:** configure the container runtime's registry credentials on each node,
  or use a kubelet credential provider.

A single option for all of this is tracked in
[#822](https://github.com/chadac-me/scooter/issues/822).

<!-- TODO(#822): replace this section with scooter.imagePullSecrets once it lands. -->

## Build your own images

Scooter's images are built from Scooter's source, so changing what's *in* them means
building from a fork. The fork already contains everything needed to publish.

### 1. Fork and change

Fork [chadac-me/scooter](https://github.com/chadac-me/scooter) and make your changes on its
`main`. For a contrib, [Writing a contrib](../writing-a-contrib/index.md) covers the code.
Remember to enable it in `.github/deployment/config.nix`, which decides what goes into the
images.

### 2. Publish from the fork

The fork includes `.github/workflows/publish-images.yml`. On every push to `main`, it
builds each image on native x86_64 and arm64 runners and pushes the results to
`ghcr.io/<your-account>/scooter/<image>`, joined into multi-arch tags. It computes each tag
exactly as rendering does, and skips any image the registry already has.

To turn it on:

- **Enable Actions** in the fork (forks start with them disabled).
- **Check the packages' visibility** after the first run, in your account's Packages
  settings. New GHCR packages are private by default. Make them public, or give your nodes
  pull credentials as above.
- **Optional:** add a `CACHIX_AUTH_TOKEN` secret for your own Cachix cache, and change the
  workflow's cache `name`. Without one, builds still read from Scooter's public cache.

The first run builds everything and takes a while. Later runs rebuild only images whose
contents changed.

### 3. Deploy from the fork

Point your deployment flake at the fork, and the manifests at its registry:

```nix
# flake.nix
inputs.scooter.url = "github:<your-account>/scooter";
```

```nix
# scooter.nix
scooter.registryPrefix = "ghcr.io/<your-account>/scooter/";
```

Because the tags come from the fork's source at the revision in your `flake.lock`, they
match what the fork's workflow published. The image check from
[Using the published images](published-images.md#check-the-images-exist) works as before,
and the weekly update workflow now tracks your fork.

### Pushing to a registry other than GHCR

To publish somewhere else, build and push each image the way the workflow does. Each image
has a flake attribute with a `copyTo` runner, and its tag is the first 12 characters of its
x86_64 store path:

```bash
# Run on x86_64 Linux, from your fork's checkout.
registry=registry.example.com/scooter
while read -r name attr; do
  out=$(nix eval --raw ".#packages.x86_64-linux.$attr.outPath")
  tag=$(basename "$out" | cut -c1-12)
  nix run ".#$attr.copyTo" -- "docker://$registry/$name:$tag"
done <<'EOF'
agent-host agent-host-image
agent-sandbox-ui ui-image
agent-broker broker-image
agent-scheduler scheduler-image
agent-webhooks webhooks-image
agent-db-migrator db-migrator-image
agent-sandbox-os sandbox-os-image
byoc-controller byoc-controller-image
conversation-controller conversation-controller-image
conversation-router conversation-router-image
warm-store-controller warm-store-controller-image
EOF
```

`copyTo` uses the credentials from `skopeo login` (or `docker login`). This pushes x86_64
images only. For arm64 nodes too, build each image on an arm64 machine as well and join
the two into a multi-arch tag, as the `manifest` job in `publish-images.yml` does.

The two Claude images (`agent-host-claude` and `remote-agent`) bundle unfree software, so
building them needs `NIXPKGS_ALLOW_UNFREE=1` and `--impure`. Leave them out unless you use
the claude-code provider or bring-your-own-Claude.

### Keeping the fork current

Merge Scooter's `main` into the fork regularly. Each merge publishes new images, and your
weekly update workflow picks them up. Contribs and fixes that others could use are worth
[upstreaming](../writing-a-contrib/testing.md#shipping-it), so you carry less in the fork.
