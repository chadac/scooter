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
, systemProfile ? "/nix/var/nix/profiles/system"
, statusDir ? "/run/scooter/env-switch"
, configPath ? "/etc/scooter/config"
, directiveEnv ? "SCOOTER_FIRSTBOOT_TARGET"
  # The no-directive BUILD STRATEGY (a shell snippet that sets `toplevel`). ONE engine, two
  # callers: the BOOTSTRAP (default) builds the config/root FLAKE; the REAL config passes its
  # base-config `nix build --expr` snippet. Retiring base-config in favour of the flake is a
  # later step — this flag lets both coexist behind one binary/script meanwhile.
, buildCommand ? ''
    if [ ! -e "$config_path/flake.nix" ]; then
      echo "scooter-rebuild: no directive and no config flake at $config_path — nothing to apply" >&2
      write_status idle
      trap - EXIT
      exit 0
    fi
    echo "scooter-rebuild: building config/root flake ($config_path#sandboxSystem)..."
    # --no-*-lock-file: the config flake ships a BAKED flake.lock at a read-only store path;
    # without these nix tries to RE-LOCK (can't write + re-resolves the nixpkgs input).
    toplevel=$(nix build --no-link --print-out-paths --impure \
      --no-update-lock-file --no-write-lock-file \
      "path:$config_path#sandboxSystem.config.system.build.toplevel")
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
  name = "scooter-rebuild";
  runtimeInputs = [ nix coreutils systemd gnugrep gawk curl gzip ];
  # shellcheck runs on the substituted body; the SC disables are inline in the .sh. Keep it ON
  # (the .sh is real shell, unlike the old inline writeText that tripped SC on Nix splicing).
  text = builtins.readFile body;
}
