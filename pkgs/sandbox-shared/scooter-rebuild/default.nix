# scooter-rebuild — THE switch command, a plain derivation shared by BOTH images.
#
# One command that builds/resolves the target toplevel + switches (generation register,
# switch-in-a-scope, health-gate → rollback). The bootstrap's boot unit calls
# `scooter-rebuild switch`; the real config's units call the same binary — ONE implementation,
# no drift. (Replaces the former scooter-apply-module — merged, since both did the same thing.)
#
# It decides "what to switch to" at RUNTIME:
#   scooter-rebuild switch [--detach]
#     1. $<directiveEnv> is an absolute path (a /nix/store toplevel present in the cloned/warm
#        upper) or a URL (curl|gunzip → path) → switch to it, NO build (bootstrap first-switch).
#     2. else → nix build path:<configPath>#sandboxSystem (the real-config re-converge; the
#        config is a flake importing ./custom).
#
# The shell body lives in ./scooter-rebuild.sh (a REAL, editable, highlightable script);
# substituteAll threads the @placeholder@ knobs so the .sh is valid shell standalone.
#
# Module-authoring subcommands (module new/edit/list/switch/status, publish) are a DISPATCHER
# layered on top by the REAL config (it has the broker + /etc/scooter/modules); the bootstrap
# ships only this switch engine (it has no broker/modules dir and only needs `switch`).

{ lib
, replaceVars
, writeShellApplication
, nix
, coreutils
, systemd
, gnugrep
, gawk
, curl
, gzip
  # The binary name. Default `scooter-rebuild` (the bootstrap uses it directly). The REAL config
  # wraps this engine in its own `scooter-rebuild` CLI dispatcher (module authoring + switch), so
  # it instantiates the engine under a DISTINCT name (scooter-rebuild-switch) and the dispatcher
  # execs it by store path — otherwise the dispatcher's `exec scooter-rebuild` recurses into itself.
, name ? "scooter-rebuild"
, systemProfile ? "/nix/var/nix/profiles/system"
, statusDir ? "/run/scooter/env-switch"
, configPath ? "/etc/scooter/config"
, directiveEnv ? "SCOOTER_FIRSTBOOT_TARGET"
  # The nixpkgs the default (impure --expr) build imports. A store PATH (the deploy sets it; a
  # bare `<nixpkgs>`-style path). Only used by the DEFAULT buildCommand below.
, nixpkgs ? "<nixpkgs>"
  # The no-directive BUILD STRATEGY (a shell snippet that sets `toplevel`). ONE engine, callers
  # differ only here. DEFAULT (the bootstrap): build config/root + config/custom as plain module
  # DIRS via `import <nixpkgs>/nixos/lib/eval-config.nix` — NO FLAKE (no flake.lock, no fetch, no
  # store-symlink games; works offline in-pod). The REAL config passes its base-config --expr
  # snippet (same shape). See memory config-root-pure-flake-delivery.
, buildCommand ? ''
    root="$config_path/root"
    custom="$config_path/custom"
    if [ ! -d "$root" ]; then
      echo "scooter-rebuild: no directive and no config/root at $root — nothing to apply" >&2
      write_status idle
      trap - EXIT
      exit 0
    fi
    echo "scooter-rebuild: building toplevel from $root + $custom (impure eval-config)..."
    # --impure: read the mounted module dirs (root baked/ConfigMap, custom on the workspace PVC).
    # custom is layered AFTER root (extends/overrides). A missing custom dir is fine (dropped).
    toplevel=$(nix build --no-link --print-out-paths --impure --expr "
      (import ${nixpkgs}/nixos/lib/eval-config.nix {
        system = builtins.currentSystem;
        modules =
          [ $root { boot.isContainer = true; } ]
          ++ (if builtins.pathExists $custom then [ $custom ] else [ ]);
      }).config.system.build.toplevel
    ")
  ''
}:

let
  # The switch body, with the Nix knobs substituted into the standalone .sh (@name@ → value).
  # replaceVars is the current nixpkgs API (substituteAll was removed).
  body = replaceVars ./scooter-rebuild.sh {
    inherit systemProfile statusDir configPath directiveEnv buildCommand;
  };
in
writeShellApplication {
  inherit name;
  runtimeInputs = [ nix coreutils systemd gnugrep gawk curl gzip ];
  # shellcheck OFF (as the original scooter-apply-module had): the `trap 'rc=$?…'` (SC2154 can't
  # see the assignment inside the trap string) + the @buildCommand@ injection shift line numbers
  # and trip SC1010/SC2154. The .sh is authored + shellcheck'd standalone during dev; the
  # runtime build must not re-fail on these dynamic patterns. `bash -n` still gates real syntax.
  checkPhase = "";
  text = builtins.readFile body;
}
