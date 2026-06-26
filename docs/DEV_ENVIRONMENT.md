# Dev Environment — Research Spec (Stage 1)

The sandbox becomes a **proper dev environment**: the agent can build/install
tools on demand, run real services (systemd), and keep the base image light via
**lazy tool stubs**. Modeled as a **NixOS configuration** (systemd PID 1
container), tested primarily with **nixosTest**.

Staged PoC: **Research (this doc)** → Design → Tests → Review → Implementation.

## Goals (from the user)

1. **Nix build/install on demand** — the agent can `nix build`/install tools, with
   a SKILL that explains the workflow (add a package, build it, where it lands on
   PATH) so it doesn't trial-and-error.
2. **systemd-enabled** — run real services. Forward-looking: collaborative envs
   (Jupyter etc.) with port-forwarding the agent can enable on request.
3. **Lazy by default** — keep the base image LIGHT. Common tools (`uv`, `python`,
   …) are PATH **stubs** that auto-build the underlying Nix package on first use,
   instead of being baked in. Build-on-demand, not build-ahead.

## Foundation decision (locked)

Model the sandbox as a **NixOS configuration** (not the current bare n2c
`sleep infinity` container). NixOS-in-a-container IS the systemd-container path.
The image is built FROM the NixOS toplevel; services are systemd units; lazy
stubs are a NixOS module. This makes `nixosTest` a native fit.

## Architecture (research-grounded)

### Image: NixOS toplevel → OCI

No official nixpkgs helper exists; the established recipe:

- `pkgs.nixos { imports = [ ./sandbox-os.nix ]; }` → `config.system.build.toplevel`.
- `boot.isContainer = true` — trims kernel/udev/hardware/boot units, KEEPS systemd
  userspace (the same switch `containers.*`/nspawn use). With stage-1 disabled the
  init lives at `${toplevel}/init`.
- Build with `dockerTools.streamLayeredImage` copying the toplevel closure.
- Image config: `/sbin/init → ${toplevel}/init`, `Cmd = ["/init"]`,
  `Env = ["container=docker"]` (set EXPLICITLY — Docker doesn't auto-set it),
  empty + writable `/etc/machine-id`.

This replaces today's `pkgs/sandbox-image` n2c image + `entrypoint.sh sleep
infinity`. The overlay-Nix-store concern is subsumed: a NixOS container has a
normal writable store path story (and `NIX_REMOTE=daemon` via isContainer).

### systemd PID 1 on Kubernetes — THE OPEN RISK

systemd PID 1 needs (per systemd CONTAINER_INTERFACE / CGROUP_DELEGATION):
- a **writable, delegated cgroup v2 subtree** (private cgroup namespace) — the
  upper hierarchy may be read-only, the leaf must be writable;
- capabilities **`CAP_SYS_ADMIN` + `CAP_MKNOD`** kept (do NOT drop);
- tmpfs on `/run`, `/run/lock`, `/tmp`, `/var/lib/journal`;
- the read-only `/sys/fs/cgroup` trick is DEAD since systemd 248.

`privileged: true` is **not strictly required** for "a few services + journald"
on cgroup v2 — but whether the agent-sandbox node exposes a delegable writable
cgroup subtree to a pod WITHOUT full privilege is **unverified on our cluster**.
This is the single biggest unknown and the first implementation-gating check.

`kubectl exec` is unaffected (new process in the namespaces, independent of PID
1); zombie reaping is CORRECT with systemd genuinely PID 1. One wrinkle: k8s
sends SIGTERM on termination; systemd's clean-shutdown signal is `SIGRTMIN+3` —
wire a mapping or a STOPSIGNAL.

### Lazy tool stubs

A stub `uv` on PATH resolves+execs the real package on first call:

```
exec "$(nix build --no-link --print-out-paths <pinned>#uv)/bin/uv" "$@"
```

- **Pin nixpkgs to a fixed rev** (`github:NixOS/nixpkgs/<rev>#uv`) → deterministic
  eval + eval-cache hits.
- **Memoize** the resolved `/nix/store/...` path to a sidecar cache on first run;
  later calls read it and `exec` directly (skips eval/build).
- Needs a working nix daemon + writable store + a reachable substituter (else
  builds from source). First call slow, then near-instant.
- Reserve `nix profile install` (bake-ahead) for the few tools that can't absorb a
  cold first call.

Modeled as a NixOS module: `programs.lazyTools = { uv = "uv"; python = "python3"; … }`
generates the stub scripts + PATH entries from a pinned nixpkgs.

## Test strategy — lean HARD on nixosTest

`runNixOSTest` boots the NixOS config in a QEMU VM with REAL systemd and drives it
with a Python testScript. Each capability gets its own small, independent test,
exposed as a flake `check`. Primitives: `wait_for_unit`, `succeed`/`fail`,
`wait_for_open_port`, `wait_until_succeeds`.

Planned independent nixosTests (the test list IS the spec):
- **lazy-stub-resolves**: a stub `uv`/`python` on PATH; first call builds + runs;
  the real binary executes; second call is fast (path memoized).
- **lazy-stub-offline-cached**: once resolved, the stub works without re-eval.
- **service-comes-up**: a sample systemd service (stand-in for Jupyter) reaches
  `active` and opens its port; `systemctl` works.
- **service-enable-on-demand**: the agent can `systemctl start` a unit that's
  installed-but-not-enabled (the "agent enables a collaborative env" path).
- **nix-build-skill-workflow**: the documented skill steps actually work — add a
  package, `nix build` it, it lands on PATH.
- **systemd-pid1-boots**: `default.target` reached, journald up (the config boots
  as a real systemd system).
- **port-forward-enable** (future): the unit + the mechanism the agent toggles.

**What nixosTest CANNOT cover** (stays Tier 2 cluster tests):
- the OCI-image packaging (layers, entrypoint, `container=` env, registry);
- the **k8s cgroup/privilege boot** (securityContext, cgroup v2 delegation, the
  agent-sandbox controller's suspend/resume, RWO-PVC + pods/exec). The systemd-
  PID-1-on-the-real-cluster check lives HERE.

So: nixosTest = config correctness (fast, deterministic, the bulk of coverage);
Tier 2 cluster = the packaging + privilege boot on a real cluster.

## Decisions (locked, 2026-06-24)

1. **Cluster privilege: `privileged: true` on dev is fine.** Design assumes
   systemd PID 1 boots; tighten capabilities post-PoC. Removes the cgroup-
   delegation unknown from the critical path. (The probe can still be run later to
   minimize privileges, but it does NOT gate the PoC.)
2. **Lazy tools: `uv` only initially, but the mechanism is EXTENSIBLE.** Model it
   as a NixOS module option so other agent configs can declare their own stubs —
   e.g. `programs.lazyTools.tools = { uv = { package = "uv"; }; … };`. Ship `uv`;
   make adding `python`/`node`/`go`/… a one-line config addition, no code change.
3. **Services: one minimal sample unit for the PoC.** A tiny systemd service that
   reaches `active` and opens a port, and that the agent can `systemctl
   start/stop`. Proves the mechanism end-to-end; real Jupyter + port-forwarding is
   a follow-up that reuses the same path.
