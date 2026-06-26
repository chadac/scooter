# Dev Environment — Design (Stage 2)

Boilerplate: file layout + all inputs/outputs defined, NO implementation. Builds
on `docs/DEV_ENVIRONMENT.md` (Research). Decisions: privileged-on-dev, `uv`-only
but extensible, one sample service.

## File layout

```
pkgs/sandbox-os/
  default.nix          # NixOS toplevel -> OCI image (dockerTools). inputs/outputs below.
modules/sandbox-os/
  default.nix          # the NixOS config: imports the pieces below + container settings
  lazy-tools.nix       # NixOS module: programs.lazyTools.* (the extensible stub mechanism)
  sample-service.nix   # NixOS module: the one sample systemd service (PoC)
nixos-tests/
  default.nix          # collects the tests, exposes them as an attrset of checks
  lazy-stub.nix        # nixosTest: a stub resolves + execs + memoizes
  service.nix          # nixosTest: the sample service comes up + systemctl start/stop
  systemd-boot.nix     # nixosTest: default.target reached, journald up
  nix-build-skill.nix  # nixosTest: the skill's documented steps actually work
skills/
  nix-dev-env.md       # the SKILL: how to build/install with nix + run services in the sandbox
docs/
  DEV_ENVIRONMENT.md          # Research (Stage 1) — done
  DEV_ENVIRONMENT_DESIGN.md   # this file (Stage 2)
```

Flake wiring (additions to `flake.nix`):
- new input `nixpkgs-pinned` (a fixed rev) — the lazy stubs resolve against THIS
  for deterministic, eval-cached resolution. Passed into the NixOS module.
- `packages.sandbox-os-image` — the new systemd image (eventually replaces
  `sandbox-image`; both coexist during the PoC).
- `checks.<name>` — one entry per nixosTest (`nix flake check` runs all).

## `pkgs/sandbox-os/default.nix` — image builder

```nix
# INPUTS
{ pkgs, lib
, nixosConfig        # the evaluated NixOS system (modules/sandbox-os) toplevel
, name ? "agent-sandbox-os"
, tag  ? "latest"
}:
# OUTPUT: { image; toplevel; }
#   image    : OCI image (dockerTools.streamLayeredImage) with:
#                /sbin/init -> ${toplevel}/init
#                Cmd = ["/init"]
#                Env includes "container=docker"
#                empty writable /etc/machine-id
#                STOPSIGNAL / SIGRTMIN+3 graceful-shutdown wiring
#   toplevel : config.system.build.toplevel (exposed for tests / debugging)
```

Implementation notes (for Stage 5, NOT now): copy the toplevel closure; symlink
init; set the container env; tmpfs dirs are runtime (pod spec), not image.

## `modules/sandbox-os/default.nix` — the NixOS config

```nix
# A NixOS module evaluated via pkgs.nixos { imports = [ ./default.nix ]; }.
{ config, lib, pkgs, nixpkgsPinned, ... }:
{
  imports = [ ./lazy-tools.nix ./sample-service.nix ];

  config = {
    boot.isContainer = true;          # trims kernel/udev/hardware; keeps systemd
    system.stateVersion = "24.11";    # pin

    # Nix usable in-pod (the agent builds/installs on demand).
    nix.settings.experimental-features = [ "nix-command" "flakes" ];
    nix.settings.substituters = [ /* cache.nixos.org + any internal */ ];

    # Base packages: DELIBERATELY MINIMAL (lazy stubs cover the rest).
    environment.systemPackages = [ /* git curl jq coreutils ... */ ];

    # The lazy-tool stubs (extensible; uv shipped). The pin comes from a mounted
    # ConfigMap (pinFile); defaultNixpkgs is the fallback for tests/local.
    programs.lazyTools = {
      enable = true;
      defaultNixpkgs = nixpkgsPinned;  # built-in fallback ref (a fixed rev)
      # pinFile defaults to /etc/agent-sandbox/nix/pin.json (mounted ConfigMap)
      tools.uv = { package = "uv"; };  # other agents add python/node/... here
    };

    # The PoC sample service (proves the systemd path).
    services.sampleDevService.enable = true;

    # broker / git-credential / aws-config wiring carried over from the old
    # entrypoint becomes systemd units / activation scripts (Stage 5).
  };
}
```

## `modules/sandbox-os/lazy-tools.nix` — THE extensible stub mechanism

```nix
# NixOS module. OPTION SCHEMA (the public, extensible interface):
{ config, lib, pkgs, ... }:
let cfg = config.programs.lazyTools; in {
  options.programs.lazyTools = {
    enable = lib.mkEnableOption "lazy Nix-built tool stubs on PATH";

    pinFile = lib.mkOption {
      type = lib.types.str;     # path to a mounted ConfigMap JSON: { "nixpkgs": "github:NixOS/nixpkgs/<rev>" }
      default = "/etc/agent-sandbox/nix/pin.json";
      description = "Path to the nixpkgs-pin ConfigMap file the stubs read at resolve time.";
    };

    defaultNixpkgs = lib.mkOption {
      type = lib.types.str;     # built-in fallback when pinFile isn't mounted (tests / local)
      description = "Fallback pinned nixpkgs ref when pinFile is absent.";
    };

    cacheDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/cache/lazy-tools";
      description = "Where resolved /nix/store paths are memoized per tool.";
    };

    tools = lib.mkOption {
      # name = the command on PATH (e.g. "uv"); value = how to resolve it.
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          package = lib.mkOption {
            type = lib.types.str;
            description = "Attr in the pinned nixpkgs (e.g. \"uv\", \"python3\").";
          };
          bin = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Binary under the package's /bin (defaults to the tool name).";
          };
        };
      });
      default = {};
      example = { uv.package = "uv"; python = { package = "python3"; bin = "python3"; }; };
      description = "Tools to expose as lazy stubs. EXTENSIBLE — agents add entries.";
    };
  };

  # OUTPUT (Stage 5): for each tool, a PATH stub script that, on first call:
  #   0. reads the nixpkgs ref: pinFile if mounted, else defaultNixpkgs.
  #   1. if cacheDir/<tool> exists AND its tagged pin rev == current -> exec it (fast)
  #   2. else: nix build --no-link --print-out-paths <ref>#<package>
  #            -> write {path, pinRev} to cacheDir/<tool> -> exec /bin/<bin>
  # config.environment.systemPackages = [ <generated stub derivation> ];
  config = lib.mkIf cfg.enable { /* generate stubs from cfg.tools */ };
}
```

The stub is the ONLY new mechanism. Adding `python`/`node`/`go` is a config line.

## `modules/sandbox-os/sample-service.nix` — PoC service

```nix
# A minimal systemd service proving the path: reaches `active`, opens a port,
# and the agent can `systemctl start/stop` it.
{ config, lib, pkgs, ... }:
let cfg = config.services.sampleDevService; in {
  options.services.sampleDevService = {
    enable = lib.mkEnableOption "the PoC sample dev service";
    port = lib.mkOption { type = lib.types.port; default = 8888; };
  };
  config = lib.mkIf cfg.enable {
    # systemd.services.sample-dev-service = { ... a tiny http listener on cfg.port ... };
  };
}
```

## `skills/nix-dev-env.md` — the SKILL (output: documentation the agent reads)

Frontmatter (name/triggers) + body covering:
- how to build/install a tool with nix in the sandbox (and that common tools are
  lazy stubs — just run `uv`, it builds on first use);
- where built tools land on PATH;
- how to run a service (systemd unit) and check it (`systemctl status`,
  `journalctl -u`);
- the one-line way to add a new lazy tool (points at `programs.lazyTools.tools`).

## Test design — nixosTests (Stage 3 writes these RED-first)

Each is an independent `pkgs.testers.runNixOSTest` exposed as a flake check.
Skeletons (assertions only; testScript filled in Stage 3):

- **systemd-boot.nix** — `nodes.machine` imports the sandbox-os config; assert
  `wait_for_unit("default.target")`, journald active, `systemctl is-system-running`
  is `running`/`degraded` (not `offline`).
- **lazy-stub.nix** — a stub `uv` on PATH; `machine.succeed("uv --version")` works
  (first call builds), the resolved path is memoized to cacheDir, a second call
  doesn't re-eval (assert via a marker / timing / cache file presence).
- **service.nix** — `wait_for_unit("sample-dev-service.service")`,
  `wait_for_open_port(8888)`, `systemctl stop` then port closed, `systemctl start`
  then open again (the agent-enable path).
- **nix-build-skill.nix** — execute the skill's documented commands; assert the
  tool ends up runnable on PATH.

**Out of nixosTest scope (Tier 2 cluster, later):** the OCI image actually boots
systemd as PID 1 in a privileged agent-sandbox pod on a real cluster; `kubectl
exec` works; suspend/resume; PVC. One cluster test asserts `systemctl
is-system-running` inside the deployed pod.

## Carry-over from the current sandbox (must not regress)

The existing `pkgs/sandbox-image` provides: overlay Nix store (subsumed by NixOS),
skills dir, the broker tools (`agent-broker`, `git-credential-broker`,
`scooter-aws*`), git-credential-broker config, `~/.aws/config` render. In Stage 5
these move into the NixOS config (systemd units / activation scripts / packages).
The PoC keeps both images until the OS image reaches parity + passes Tier 2.

## Review decisions (Stage 4, resolved 2026-06-24)

1. **nixpkgs pin via ConfigMap (not baked into the image).** The pinned nixpkgs
   rev lives in a **ConfigMap mounted into the pod** (e.g. `/etc/agent-sandbox/nix/pin.json`
   → `{ "nixpkgs": "github:NixOS/nixpkgs/<rev>" }`), mirroring how the AWS accounts
   registry is already a mounted ConfigMap. The lazy-stub eval READS the pin from
   there at resolve time — so re-pinning is a ConfigMap edit, no image rebuild.
   `programs.lazyTools.nixpkgs` becomes a PATH to the pin file (default points at the
   mount), not a hardcoded ref. **Cache keying:** the memoized store path in
   `cacheDir/<tool>` is tagged with the pin rev; a mismatch → re-resolve. (Falls
   back to a built-in default pin if the ConfigMap isn't mounted, e.g. nixosTest.)
2. **Login-shell exec — confirmed.** `kubectl exec` must land a shell with the lazy
   stubs on PATH and `HOME` set, so the agent runs `uv …` directly and it just
   works. Ensure the exec env (systemd/PAM may differ) carries PATH + HOME.
3. **Keep both images until parity + Tier 2 — confirmed.** No regression to the
   broker tools / git-credential / aws-config carry-over; the OS image proves out
   behind the existing one.
4. **`cache.nixos.org` egress is available in-pod — confirmed.** First-call stub
   builds substitute from cache.nixos.org; no internal substituter needed.
5. **`nix build` in-pod** needs the nix daemon as a systemd unit (NixOS provides
   `nix-daemon.service` by default once nix is enabled).
