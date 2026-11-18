# Base-config builder shipped into the sandbox image so the pod can rebuild its
# own system toplevel at runtime from the base config plus a deployment's
# module, then `switch-to-configuration` to it.
#
# It mirrors the pkgs/sandbox-os evaluation so the converged toplevel matches the
# booted one except for the injected module, which keeps systemd constant and the
# switch from re-execing PID 1. `nixpkgs` and `modulesPath` are store paths baked
# into the image, so the in-pod build needs no network.

{ nixpkgs            # store path of the pinned nixpkgs source
, modulesPath        # store path of modules/sandbox-os
, extraModules ? [ ] # the deployment's modules to inject
, system ? builtins.currentSystem
}:

let
  # `nixpkgs` may arrive as a bare store path or a `path:`-prefixed string, with
  # or without store context; every embedded value is derived context-free so the
  # toplevel hashes identically either way, while values read through (`import`,
  # `pathExists`) keep their context so pure eval can access them.
  nixpkgsArg = toString nixpkgs; # context preserved: read through this, never embed it
  nixpkgsStr = builtins.unsafeDiscardStringContext nixpkgsArg;
  hasPathPrefix = builtins.substring 0 5 nixpkgsStr == "path:";
  prefixLen = if hasPathPrefix then 5 else 0;
  # The bare store-path string applyModule interpolates unquoted into the next
  # converge's expr.
  nixpkgsBare = builtins.substring prefixLen (-1) nixpkgsStr;
  # What `import` reads: the caller's own path or context-carrying string when
  # there is one, else a reconstructed absolute path.
  nixpkgsPath =
    if builtins.isPath nixpkgs then nixpkgs
    else if builtins.hasContext nixpkgsArg then builtins.substring prefixLen (-1) nixpkgsArg
    else /. + nixpkgsBare;
  # The `path:` string form, never double-prefixed.
  nixpkgsRef = if hasPathPrefix then nixpkgsStr else "path:" + nixpkgsStr;
  # The baked source-tree root, obtained by stripping the fixed subdir from
  # modulesPath.
  modulesPathArg = toString modulesPath; # context preserved, as with nixpkgsArg
  modulesPathStr = builtins.unsafeDiscardStringContext modulesPathArg;
  modulesSubdir = "/modules/sandbox-os";
  rootLen = builtins.stringLength modulesPathStr - builtins.stringLength modulesSubdir;
  modulesTreeRoot = builtins.substring 0 rootLen modulesPathStr;
  # The vendored nix-stubs bits stub-set.nix needs to rebuild the stub overlay,
  # null when absent.
  stubBitsRoot =
    if builtins.hasContext modulesPathArg then builtins.substring 0 rootLen modulesPathArg
    else modulesTreeRoot;
  stubBits =
    if !builtins.pathExists (stubBitsRoot + "/nix-stubs/nix/lock.nix") then null
    else {
      lockLib = import (stubBitsRoot + "/nix-stubs/nix/lock.nix") {
        lib = import (nixpkgsPath + "/lib");
      };
      flakeLock = stubBitsRoot + "/flake.lock";
      # stubs.nix's extra arguments, vendored by reconverge-inputs.nix.
      stubArgs =
        let dir = stubBitsRoot + "/stub-args"; in
        if builtins.pathExists dir
        then builtins.mapAttrs (name: _: dir + "/${name}") (builtins.readDir dir)
        else { };
      # The image's derivation, so shims keep their store paths.
      nix-stubs = import (stubBitsRoot + "/modules/sandbox-os/nix-stubs-package.nix") {
        inherit system;
        nixpkgs = nixpkgsPath;
        src = stubBitsRoot + "/nix-stubs";
      };
    };

  evaled = import (nixpkgsPath + "/nixos/lib/eval-config.nix") {
    inherit system;
    modules = [
      modulesPath
      { boot.isContainer = true; }
      ({ lib, ... }: {
        # stub-set.nix turns these into the overlay.
        _module.args.stubBits = stubBits;
        devEnvNix.nixpkgs = lib.mkForce nixpkgsRef;
        # Keep the rebuild tooling on PATH across the re-converge, and re-inject
        # the bare nixpkgs path the option requires.
        programs.scooterModule.enable = lib.mkForce true;
        programs.scooterModule.nixpkgs = lib.mkForce nixpkgsBare;
        # Reference the already-baked source tree so the offline build does not
        # re-derive a sandbox-os-src that is not in the store.
        programs.scooterModule.modulesTree = lib.mkForce modulesTreeRoot;
      })
    ] ++ extraModules;
  };
in
{
  inherit (evaled) config;
  toplevel = evaled.config.system.build.toplevel;
}
