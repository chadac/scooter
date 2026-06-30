# programs.scooterModule — apply a deployment's `.scooter/module.nix` (a NixOS
# module) into the running sandbox AT RUNTIME via switch-to-configuration. No
# image rebuild, no flake ref: the module is MOUNTED (e.g. a ConfigMap) and the
# pod rebuilds its own toplevel (base config + the mounted module) and switches.
#
# This unifies the dev-env work: full NixOS-module power (packages, systemd
# services, config) delivered at runtime, the way the switch-specialisation spike
# proved (PID 1 survives, ~seconds, only the changed-unit diff restarts).
#
# Ships into the image:
#   - the base-config builder expression (runtime-converge/base-config.nix);
#   - the pinned nixpkgs + the modules/sandbox-os source, as store paths, so the
#     in-pod build needs no network/ref;
#   - `scooter-apply-module`: build <base + mounted module> -> switch.
#
# See docs/HYPERNIX_INJECTION.md.

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scooterModule;

  baseConfig = ./runtime-converge/base-config.nix;

  # The base config (modules/sandbox-os) reaches a few files OUTSIDE its own dir
  # via `../../` relative paths: the broker-tools overlay (pkgs/broker-tools, which
  # reads the broker scripts + cli.py). For the in-pod rebuild to resolve those, we
  # vendor a small source TREE placing modules/sandbox-os AND pkgs/broker-tools +
  # the broker cli.py at the same relative layout. modulesPath then points at
  # <tree>/modules/sandbox-os; the overlay's `../../pkgs/broker-tools` resolves.
  modulesTree = pkgs.runCommand "sandbox-os-src" { } ''
    mkdir -p $out/modules $out/pkgs $out/services/broker/broker/aws
    cp -r ${lib.cleanSource ./.} $out/modules/sandbox-os
    cp -r ${../../pkgs/broker-tools} $out/pkgs/broker-tools
    cp ${../../services/broker/broker/aws/cli.py} $out/services/broker/broker/aws/cli.py
  '';
  modulesSrc = "${modulesTree}/modules/sandbox-os";

  applyModule = pkgs.writeShellApplication {
    name = "scooter-apply-module";
    runtimeInputs = [ pkgs.nix pkgs.coreutils pkgs.systemd ];
    checkPhase = "";
    text = ''
      # scooter-apply-module — re-converge this sandbox to include the mounted
      # deployment module, via switch-to-configuration. Idempotent.
      set -euo pipefail

      module_dir=${lib.escapeShellArg cfg.dir}
      module="$module_dir/module.nix"

      if [ ! -e "$module" ]; then
        echo "scooter-apply-module: no module at $module — nothing to apply" >&2
        exit 0
      fi

      echo "scooter-apply-module: building toplevel (base + $module)..."
      # Build base config + the mounted module. --impure so we can read the
      # mounted path; the nixpkgs + modules source are fixed store paths baked in.
      # We also re-inject programs.scooterModule.nixpkgs so the re-evaluated base
      # config (which imports this same module) type-checks — it has no default.
      toplevel=$(nix build --no-link --print-out-paths --impure --expr "
        (import ${baseConfig} {
          nixpkgs = ${cfg.nixpkgs};
          modulesPath = ${modulesSrc};
          extraModules = [
            ({ lib, ... }: { programs.scooterModule.nixpkgs = lib.mkForce ${cfg.nixpkgs}; })
            $module
          ];
        }).toplevel
      ")

      echo "scooter-apply-module: switching to $toplevel..."
      # Run the switch in a TRANSIENT systemd scope, detached from THIS unit.
      # switch-to-configuration restarts the changed-unit diff — which includes
      # scooter-apply-module.service itself — and would SIGTERM us mid-switch if we
      # ran it inline (the service would 'fail' even though the build succeeded).
      # A --scope process isn't a unit the switch manages, so it survives.
      # (bootloader install is /bin/true under boot.isContainer.)
      systemd-run --scope --collect --quiet \
        --unit="scooter-switch-$$" \
        "$toplevel/bin/switch-to-configuration" switch
      echo "scooter-apply-module: applied."
    '';
  };
in
{
  options.programs.scooterModule = {
    enable = lib.mkEnableOption "runtime application of a mounted .scooter/module.nix via switch-to-configuration";

    dir = lib.mkOption {
      type = lib.types.str;
      default = "/etc/agent-sandbox/scooter";
      description = "Mount path of the deployment's .scooter dir (contains module.nix).";
    };

    nixpkgs = lib.mkOption {
      type = lib.types.str;
      description = ''
        Store path to the pinned nixpkgs the in-pod toplevel build uses (same rev
        the image was built from). Injected by the image builder so the build is
        deterministic + offline.
      '';
    };

    applyOnBoot = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run scooter-apply-module once at boot if a module is mounted.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ applyModule ];

    # CRITICAL: the in-pod `nix build` imports the modules tree (shipped here) and
    # the nixpkgs source. cfg.nixpkgs is a bare string (no Nix context), so it is
    # NOT pulled into the image closure by itself — the IMAGE BUILDER must add the
    # nixpkgs source to system.extraDependencies (where it still has context).
    # Without both, the in-pod build fails with "path does not exist".
    system.extraDependencies = [ modulesTree ];

    # Apply the mounted module at boot (best-effort; a missing module is a no-op).
    # The agent-host can also exec scooter-apply-module on spawn/claim.
    systemd.services.scooter-apply-module = lib.mkIf cfg.applyOnBoot {
      description = "Apply the mounted .scooter/module.nix via switch-to-configuration";
      wantedBy = [ "multi-user.target" ];
      after = [ "nix-daemon.socket" ];
      # The switch this unit runs will restart the changed-unit diff — which would
      # include THIS unit — and SIGTERM the running switch. Tell the switch to
      # leave this unit alone (it's a deliberate self-applying oneshot).
      restartIfChanged = false;
      stopIfChanged = false;
      unitConfig.X-StopOnReconfiguration = false;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${applyModule}/bin/scooter-apply-module";
      };
    };
  };
}
