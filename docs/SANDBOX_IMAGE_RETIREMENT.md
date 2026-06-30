# Retire pkgs/sandbox-image + restructure the sandbox store/tools

Status: **DESIGN (for review)**.

Retires the legacy non-systemd OCI sandbox image and restructures how the
NixOS dev-environment sandbox image (`pkgs/sandbox-os`) vends tools + manages its
Nix store. Four parts (separable into commits):

## Decisions (confirmed)

1. **Broker tools are prebuilt on the image** (always needed; small cost). They
   become a proper **nixpkgs overlay** (`scooterBrokerTools`) — NOT lazy stubs,
   NOT `builtins.readFile`d `.sh` from `pkgs/sandbox-image/`. This is what lets
   the old image be deleted.
2. **Store split via a local-overlay-store**: the image's baked `/nix/store` is
   the **read-only LOWER**; a **writable UPPER** (emptyDir/tmpfs at runtime)
   catches everything built after boot (lazy stubs, in-pod nix, runtime-converge).
   Immutable base, isolated + discardable runtime mutations.
3. **nix-stubs is wired in** (flake input + overlay plumbing) so tools *can* be
   lazy via the standalone mechanism, but the **basic/default tools stay
   prebuilt** for now. A future TODO leans more on lazy.
4. **conversation.nix synced** to the TS provisioner (systemd privileged + tmpfs).

---

## Part 1 — Broker-tools overlay (kills the readFile drift + unblocks the delete)

NEW: `pkgs/broker-tools/` — an overlay/package set exposing the broker tools as
real derivations, with the `.sh` sources living HERE (moved from sandbox-image):
```
pkgs/broker-tools/
  default.nix         # { agent-broker, git-credential-broker, scooter-aws, scooter-aws-credentials }
  agent-broker.sh             (moved from pkgs/sandbox-image/)
  git-credential-broker.sh    (moved from pkgs/sandbox-image/)
  # scooter-aws* still embed services/broker/broker/aws/cli.py (one source of truth, unchanged)
```
- Exposed as a **flake overlay** (`overlays.brokerTools`) so `pkgs.scooterBrokerTools`
  is available wherever the sandbox config is evaluated.
- `modules/sandbox-os/carry-over.nix` consumes `pkgs.scooterBrokerTools.*` instead
  of `builtins.readFile ../../pkgs/sandbox-image/...`. Same scripts, one source of
  truth, no `pkgs/sandbox-image` dependency.
- The boot-time oneshot units (git-broker, aws-config) in carry-over.nix stay.

## Part 2 — Delete pkgs/sandbox-image

Once Part 1 removes the last consumer:
- `rm -rf pkgs/sandbox-image/` (the `default.nix` builder + the now-moved `.sh`).
- `flake.nix`: drop `sandboxImage` (the old builder import), the `sandbox-image`
  package, and `legacyPackages.sandboxImage`. **`packages.default`** currently =
  the old image → repoint to `sandbox-os-image` (the survivor).
- `test/support/cluster-up.sh`: drop `build_and_import ".#sandbox-image"`; the
  sandbox-os image is already built there.
- Cluster tests that default `SANDBOX_IMAGE ?? "agent-sandbox-nix:latest"` →
  default to the OS image name (`agent-sandbox-os:latest`).
- `modules/platform.nix` `sandboxImage` option default: `agent-sandbox-nix:latest`
  → `agent-sandbox-os:latest` (+ flip `sandboxSystemd` default? — see open Qs).
- Docs (README, CLAUDE.md, DESIGN, DEV_ENVIRONMENT) — update the references.
- `modules/sandbox-template.nix` / `agent-host.nix` / `conversation.nix` /
  `default.nix` reference the `sandboxImage` OPTION (not the package) — those stay,
  only the default value + descriptions change.

## Part 3 — local-overlay-store (read-only base + writable upper)

The sandbox-os image's `/nix/store` is baked read-only; runtime writes (lazy
stub realization, in-pod `nix build`, runtime-converge) currently mutate the
image's store directly (works because the pod fs is writable, but it's not clean
isolation). Switch to a **local-overlay-store**:
- The image ships its store as the **lower** (read-only).
- At boot, mount a writable **upper** (an emptyDir or tmpfs at `/nix/.overlay-store`)
  and configure Nix's `store` to the overlay so new paths land in the upper.
- nix.conf / a boot oneshot sets up the overlay store; the lazy-tool + in-pod-nix
  paths then write to the upper transparently.
- Wins: the baked closure can't be corrupted; runtime store is discardable per pod
  (good for warm-pool reuse + suspend/resume hygiene).
- This is the most experimental part (the store type is "experimental" in Nix);
  it gets its OWN nixosTest proving a lazy build lands in the upper + the base
  stays read-only.

## Part 4 — nix-stubs flake input + overlay plumbing

- Add `nix-stubs` as a flake input (`github:chadac/nix-stubs`, or the local path
  during dev).
- Expose its `mkOverlay` / the `nix-stubs` binary so the sandbox config CAN make
  any nixpkgs tool a lazy stub via nix-stubs (replacing the homegrown
  `config.lib.mkLazyTool` shell stub for the nixpkgs-attr case).
- KEEP the homegrown `mkLazyTool` for the source it has that nix-stubs lacks: the
  **flake / `.scooter` injection** source (`flake = "<dir>"; package = "x"` →
  `nix build path:<dir>#x`). nix-stubs handles nixpkgs-attr tools; the
  `.scooter`/local-flake injection stays on the homegrown path until nix-stubs
  grows an equivalent. (So they coexist: nix-stubs for nixpkgs tools, homegrown
  for injected flakes.)
- **No tool becomes lazy that wasn't already** — basic tools stay prebuilt; this
  is plumbing for the future lazy TODO.

## Part 5 — conversation.nix ⇄ provisioner sync

`modules/conversation.nix` (the kubenix mirror of the TS k8sProvisioner) has
drifted: the provisioner sets `systemdImage` → privileged + tmpfs `/run`,`/tmp`
(SANDBOX_SYSTEMD path), but the kubenix mirror doesn't. Sync it so rendered
manifests match what the agent-host actually provisions:
- privileged securityContext + tmpfs `/run`,`/tmp` volumes when the sandbox is the
  systemd OS image.

## Build / commit order
1. Broker-tools overlay (Part 1) — additive; carry-over repointed; nixosTests green.
2. Delete sandbox-image (Part 2) — flake/cluster/docs; default → OS image.
3. conversation.nix sync (Part 5) — manifest parity; check-manifests.
4. nix-stubs input + plumbing (Part 4) — flake input + overlay; tools still prebuilt.
5. local-overlay-store (Part 3) — boot setup + its own nixosTest. (Most experimental;
   could split to its own PR if it gets hairy.)

## What landed in THIS PR (Parts 1, 2, 5 + always-systemd)
- Part 1 — pkgs/broker-tools (broker CLIs prebuilt; scripts moved from sandbox-image);
  carry-over.nix callPackages it (no readFile drift); runtime-converge vendors it.
- Part 2 — pkgs/sandbox-image DELETED; flake default → sandbox-os; image name
  agent-sandbox-nix → agent-sandbox-os everywhere.
- systemd ALWAYS on — removed `sandboxSystemd` (option + SANDBOX_SYSTEMD env);
  index.ts passes systemdImage:true unconditionally.
- Part 5 — conversation.nix synced to the provisioner (privileged + tmpfs /run,/tmp).

## Landed in a FOLLOW-UP PR
- **local-overlay-store (was Part 3) — DONE + VM-TESTED.** `modules/sandbox-os/
  overlay-store.nix` (off by default, `programs.overlayStore.enable`) +
  `nixos-tests/overlay-store.nix`. Compose-on-top: bind-pin whatever /nix/store IS
  as the read-only lower, stack a writable upper — works over a baked OCI store,
  a bare EC2/VM host store, OR the nixosTest framework's own overlay (so the VM
  test DOES validate it, contrary to the earlier note — the trick was the
  compose-on-top lower + reconciling register-nix-paths in the test). The VM test
  proves a real `nix build` lands in the upper and the lower stays read-only.
  Recipe + the #11840 work-arounds are documented in the module and the commit;
  the rootless proof is `docs/spikes/local-overlay-store-mwe.sh`. **The upper must
  be DISK-backed (emptyDir/PVC), NOT tmpfs** — a RAM upper would charge every
  runtime-built nix closure to pod memory. This is a NIX local-overlay *store*
  within the pod's already-overlayfs root, NOT a second docker overlay.
  - Tier-2 cluster test DONE (`test/cluster/overlay-store.spec.ts`, 6/6 on k3d):
    runs `.#sandbox-os-overlay-image` in a real privileged pod, lower = the baked
    store, no register-nix-paths — and a real `nix build` lands in the upper. This
    surfaced a prod gap the VM couldn't: a dockerTools image ships store paths but
    NO Nix DB / `.links`, so the read-only lower had nothing to open. Fixed in
    `pkgs/sandbox-os` by baking the closure registration into `/nix/var/nix/db`
    (`nix-store --load-db`) + creating `.links` at image-build time.
  - Still TODO: wire the upper volume into conversation.nix/the provisioner +
    flip overlayStore on in the default image.
- **nix-stubs (was Part 4).** Add the flake input (local path:../nix-stubs → github:
  when ready) + mkOverlay plumbing so tools CAN be lazy; keep basic tools prebuilt.
  KEEP the homegrown mkLazyTool for the .scooter/local-flake injection source.
