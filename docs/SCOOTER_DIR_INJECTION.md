# Deployment-injected tools via a mounted `.scooter/` dir

How a DEPLOYMENT adds its own CLI tools to the GENERIC sandbox at runtime,
without baking them into the base image and without a flake ref.

## Boundary (important)

- **THIS repo (generic platform):** only the MECHANISM — `programs.lazyTools`
  tools with a `localFlake` source — plus a generic SAMPLE tool in the tests
  (`injected-tool`) proving it works. NO deployment-specific tools or logic here.
- **The DEPLOYMENT repo:** the actual tools (e.g. `example-review`, wrapping a
  deployment-specific credential mechanism), the `.scooter/` flake that defines
  them, the ConfigMap that ships it, and the mount wiring. The provisioning logic
  lives there.

## The `.scooter/` convention

A deployment puts a Nix **flake** at `.scooter/` in its repo, exposing its tools:

```nix
# example-app/.scooter/flake.nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/<pinned-rev>";
  outputs = { self, nixpkgs }: {
    packages.<system>.example-review =
      nixpkgs.legacyPackages.<system>.writeShellApplication {
        name = "example-review"; text = ''…credential-broker wrapper…'';
      };
  };
}
```

## Delivery + resolution (no flake ref)

1. The `.scooter/` dir is shipped as a **ConfigMap** and MOUNTED into the sandbox
   at `/etc/agent-sandbox/scooter` (a real directory). No ref: testing is just
   `kubectl create configmap … --from-file=./.scooter/`.
2. The deployment declares its tool as a `localFlake` lazy tool (in its sandbox
   config overlay):
   ```nix
   programs.lazyTools.tools.example-review = {
     package = "example-review";
     localFlake = "/etc/agent-sandbox/scooter";
   };
   ```
3. The lazy stub, on first call, runs `nix build path:/etc/agent-sandbox/scooter#example-review --impure`
   (built from the MOUNTED dir; `--impure` lets a path-pinned nixpkgs input
   resolve without a strict content lock), memoizes the result, execs it. Fast —
   it's just a package, not a system rebuild.

## What's proven here

`nixos-tests/injected-tool.nix` (`dev-env-injected-tool`, GREEN): a sample tool
in a mounted `.scooter/` flake is on PATH as a lazy stub, builds `path:<dir>#tool`
from the mount on first call, runs, memoizes, and errors clearly when the dir
isn't mounted. Offline/hermetic (the fixture's nixpkgs input is rewritten to the
test's nixpkgs source).

## What the deployment must add (the deployment side)

1. `.scooter/flake.nix` defining `example-review` (wraps the deployment's
   credential mechanism: SA-token auth against a deployment-specific audience and
   URL; whatever subcommands the tool needs).
2. A ConfigMap from `.scooter/` (kubenix-rendered, or `--from-file` for testing).
3. Per-conversation Sandbox: mount that ConfigMap at `/etc/agent-sandbox/scooter`
   + a projected SA token (deployment-specific audience) + the tool's config env
   (the provisioner gains an optional `.scooter` mount, gated like the AWS mount).
4. `programs.lazyTools.tools.example-review = { package = "example-review"; localFlake
   = "/etc/agent-sandbox/scooter"; }` in the deployment's sandbox config overlay.

## Heavier path (parked)

If a deployment needs to inject systemd SERVICES (not just CLI tools), the
`.scooter/module.nix`-as-a-NixOS-module + `switch-to-configuration` approach is
parked on `wip/runtime-converge-module` (the in-pod toplevel rebuild is heavy).
Revive it only when service-injection is genuinely needed; for CLIs, the light
lazy-tool path above is the answer.
