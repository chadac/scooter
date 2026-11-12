# NixOS dev-environment sandbox image: the shared modules/sandbox-os config
# evaluated with `boot.isContainer = true` and packaged as a nix2container OCI
# image whose entrypoint boots systemd as PID 1. Container-only packaging concerns
# (isContainer, the overlay store, the unmanaged /etc/hosts) live in ./container.nix
# rather than in modules/sandbox-os, which the nixosTests import bare. Output: { image;
# toplevel; nixos; }.

{ pkgs, lib, n2c
, name ? "agent-sandbox-os"
, tag ? "latest"
  # Which contribs to ship. Passed in: this tree is vended.
, deploymentModules ? [ ]
, extraModules ? [ ]   # extra NixOS config for boot only, dropped by a self-modify
  # Extra NixOS modules as repo-relative files ("contrib/aws/sandbox.nix"), imported
  # into the booted system and baked into the re-converge list so they survive a
  # self-modify.
, extraModuleFiles ? [ ]
  # { src; package; stubArgs; } of nix-stubs, vendored with stubs.nix's extra arguments
  # (stubArgs) so a self-modify can rebuild the stub overlay in-pod (null in nixosTests).
, nixStubs ? null
}:

let
  # The nixpkgs source the in-pod re-converge imports, pinned as one `builtins.path`
  # derivation used for both the apply script and the closure, since `toString
  # pkgs.path` and the coerced `pkgs.path` name different store paths.
  nixpkgsSource = builtins.path { path = pkgs.path; name = "source"; };
  # The context-free store-path string of that source, matching what base-config.nix
  # uses at re-converge so the derivations hash identically on both sides.
  nixpkgsSourceStr = builtins.unsafeDiscardStringContext (toString nixpkgsSource);

  # The enabled contribs' sandbox halves, evaluated only here at image build and
  # carried by the generic re-converge list below.
  contribSandbox = import ../../contrib/sandbox-modules.nix {
    inherit lib;
    extraModules = deploymentModules;
  };

  nixos = pkgs.nixos ({ lib, ... }: {
    imports = [ ../../modules/sandbox-os ./container.nix ]
      ++ contribSandbox.modules
      ++ map (f: ../../. + "/${f}") extraModuleFiles
      ++ extraModules;

    # The same files repo-relative, so the re-converge replays them from the vendored
    # tree (a module imported above but missing here is dropped by the first self-modify).
    programs.scooterModule.extraReconvergeModuleFiles =
      [ "pkgs/sandbox-os/container.nix" ] ++ contribSandbox.treeRelative ++ extraModuleFiles
      # The skill directories, as reconverge-inputs.nix baked them into the tree.
      ++ lib.optional (contribSandbox.skillDirs != { }) "skill-dirs/module.nix";

    scooter.skillDirs = contribSandbox.skillDirs;

    # The nix-stubs source and binary for runtime-converge.nix to vendor.
    _module.args.nixStubs = nixStubs;

    # The pinned nixpkgs the dev-env registry resolves against, the `path:` ref of the
    # same source the re-converge uses.
    devEnvNix.nixpkgs = lib.mkForce "path:${nixpkgsSourceStr}";

    # Runtime re-converge; base-config.nix `import`s this path, so it must be a bare
    # store path rather than a `path:` flake ref.
    programs.scooterModule = {
      enable = lib.mkDefault true;
      nixpkgs = lib.mkForce nixpkgsSourceStr;
    };
    # Ship the same source object the script references, so the in-pod build is offline.
    system.extraDependencies = [ nixpkgsSource ]
      # Uncached, so each sandbox would otherwise build it from stdenv.
      ++ lib.optional (pkgs.uv ? real) pkgs.uv.real;
  });

  toplevel = nixos.config.system.build.toplevel;

  # The Nix path registration for the whole system closure, for the baked store DB.
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };

  # Files baked at the image root: the init symlink, a writable machine-id, and the
  # dirs systemd expects to exist at first boot.
  rootExtras = pkgs.runCommand "sandbox-os-root" { } ''
    mkdir -p $out/sbin $out/etc
    ln -s ${toplevel}/init $out/sbin/init
    # Empty and writable so first boot seeds it.
    : > $out/etc/machine-id
    # systemd writes to these at boot.
    mkdir -p $out/var/log $out/run $out/tmp
    chmod 1777 $out/tmp
  '';

  # The baked Nix DB and the full /nix/var/nix state layout, produced by a real
  # `nix-store --load-db` because the overlay store's read-only lower expects the
  # complete state dir.
  nixDb = pkgs.runCommand "sandbox-os-nixdb" { } ''
    export NIX_STATE_DIR=$out/nix/var/nix
    mkdir -p $out/nix/var/nix $out/nix/store/.links
    ${pkgs.buildPackages.nix}/bin/nix-store --load-db < ${closure}/registration
  '';

  # ── IMAGE LAYERS ─────────────────────────────────────────────────────────────
  # Explicit layers with `reproducible = false`, so every layer tar is stored in its
  # derivation and the layer digests cannot differ between machines (which makes a
  # cache-fetched manifest unpushable).

  # The system closure, split so a source-tree change re-pushes only the small group.
  baseLayer = n2c.buildLayer {
    deps = [ toplevel ];
    layersFile = "${srcSplit}/split.json";
    reproducible = false;
  };

  # Two groups: paths that reach the vendored sandbox-os-src, then the stable rest.
  srcSplit = pkgs.runCommand "sandbox-os-layer-split" {
    __structuredAttrs = true;
    exportReferencesGraph.graph = [ toplevel ];
    nativeBuildInputs = [ pkgs.jq ];
  } ''
    mkdir $out
    jq '.graph as $g
      | ($g | map({ key: .path, value: .references }) | from_entries) as $refs
      | { new: [ $g[].path | select(endswith("-sandbox-os-src")) ] }
      | .seen = .new
      | until(.new == [];
          (.seen | map({ key: ., value: true }) | from_entries) as $s
          | .new = [ $g[].path | select($s[.] | not)
                     | select(any($refs[.][]; $s[.])) ]
          | .seen += .new)
      | (.seen | map({ key: ., value: true }) | from_entries) as $v
      | [ [ $g[].path | select($v[.] | not) ], [ $g[].path | select($v[.]) ] ]
      | map(sort)' .attrs.json > $out/split.json
    # An empty group is rejected by nix2container, so fail here with a clear reason.
    jq -e 'all(length > 0)' $out/split.json >/dev/null \
      || { echo "sandbox-os-src is missing from the toplevel closure" >&2; exit 1; }
  '';

  # The image-root files and the baked Nix DB; `layers = [ baseLayer ]` skips paths
  # already in the base layer, and `deps = [ initWrapper ]` keeps the entrypoint out
  # of buildImage's implicit computed-at-push customization layer.
  volatileLayer = n2c.buildLayer {
    copyToRoot = [ rootExtras nixDb ];
    deps = [ initWrapper ];
    layers = [ baseLayer ];
    maxLayers = 1;
    reproducible = false;
  };

  initWrapper = pkgs.writeScript "sandbox-init-wrapper" ''
    #!${pkgs.busybox}/bin/sh
    # PID-1 wrapper: a non-privileged container gets a read-only /sys/fs/cgroup, which
    # makes systemd exit 255 silently, so remount it rw (needs CAP_SYS_ADMIN), report
    # the outcome without ever failing the boot, then exec the NixOS stage-2 init.
    cg_err=$(${pkgs.util-linux}/bin/mount -o remount,rw /sys/fs/cgroup 2>&1)
    cg_rc=$?
    if [ "$cg_rc" -ne 0 ]; then
      # In a user-namespaced pod (hostUsers: false) the inherited mount's read-only flag is
      # locked and cannot be remounted away, but the pod owns its cgroup namespace, so a fresh
      # cgroup2 mount over it is allowed and comes up writable.
      cg_err="$cg_err; fresh mount: $(${pkgs.util-linux}/bin/mount -t cgroup2 -o nsdelegate cgroup2 /sys/fs/cgroup 2>&1)"
      cg_rc=$?
      [ "$cg_rc" -eq 0 ] && echo "sandbox-init: mounted a fresh cgroup2 at /sys/fs/cgroup (user namespace)"
      # systemd needs the subtree owned by our root; report what we got.
      echo "sandbox-init: cgroup owner=$(${pkgs.busybox}/bin/stat -c %u:%g /sys/fs/cgroup) procs=$(${pkgs.busybox}/bin/stat -c %u:%g /sys/fs/cgroup/cgroup.procs 2>&1) self=$(${pkgs.busybox}/bin/cat /proc/self/cgroup)"
      if ${pkgs.busybox}/bin/mkdir /sys/fs/cgroup/.probe 2>/tmp/cg-probe; then
        ${pkgs.busybox}/bin/rmdir /sys/fs/cgroup/.probe; echo "sandbox-init: cgroup subtree writable"
      else
        echo "sandbox-init: cgroup subtree NOT writable: $(${pkgs.busybox}/bin/cat /tmp/cg-probe)"
      fi
    else
      echo "sandbox-init: remount rw /sys/fs/cgroup OK"
    fi
    if [ "$cg_rc" -ne 0 ]; then
      echo "sandbox-init: remount rw /sys/fs/cgroup FAILED rc=$cg_rc -- systemd will exit 255"
      echo "sandbox-init: mount said: $cg_err"
      echo "sandbox-init: CapEff=$(${pkgs.busybox}/bin/grep ^CapEff /proc/self/status 2>/dev/null)"
      ${pkgs.busybox}/bin/grep cgroup /proc/mounts 2>/dev/null \
        | ${pkgs.busybox}/bin/sed "s/^/sandbox-init: /" || true
    fi
    # Opt-in verbose systemd boot, for tests chasing a silent exit.
    if [ "''${SANDBOX_INIT_DEBUG:-}" = 1 ]; then
      export SYSTEMD_LOG_LEVEL=debug SYSTEMD_LOG_TARGET=console
    fi
    exec ${toplevel}/init "$@"
  '';
  # nix build .#sandbox-os-image  ->  a nix2container image booting systemd PID 1.
  image = n2c.buildImage {
    inherit name tag;

    # Explicit layers with copyToRoot left empty, since anything put there
    # goes through the implicit customization layer that is recomputed at push.
    layers = [ baseLayer volatileLayer ];

    # maxLayers applies to the (empty) customization layer.
    maxLayers = 1;

    config = {
      # Boot systemd PID 1 via the init wrapper.
      Entrypoint = [ "${initWrapper}" ];
      # systemd's container detection, which Docker does not set itself.
      Env = [
        "container=docker"
        # PID 1's PATH is inherited by every kubelet exec, so the per-user nix profile
        # and the setuid wrappers come first.
        "PATH=/workspace/.nix-profile/bin:/run/wrappers/bin:/run/current-system/sw/bin:/usr/bin:/bin"
        "UV_NIX_NIXPKGS=${nixos.config.environment.variables.UV_NIX_NIXPKGS}"
      ];
      # systemd's clean-shutdown signal differs from k8s's default SIGTERM.
      StopSignal = "SIGRTMIN+3";
      WorkingDir = "/workspace";
    };
  };
  # Local-only push scripts, so image JSON and layers match.
  image' = image // lib.genAttrs
    [ "copyTo" "copyToDockerDaemon" "copyToRegistry" "copyToPodman" ]
    (attr: image.${attr}.overrideAttrs { allowSubstitutes = false; });
in
# Not only an image: the contrib-sandbox check reads nixos too.
{ inherit toplevel nixos; image = image'; }
