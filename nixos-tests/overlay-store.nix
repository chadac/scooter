# nixosTest: the read-only-lower + writable-upper Nix overlay store boots in the
# systemd dev-environment, the base store stays read-only, and a path BUILT at
# runtime lands in the writable upper — not the base.
#
# This is the riskiest dev-env piece (local-overlay-store is experimental + the
# overlayfs-over-/nix/store boot must not pull the rug from under PID 1), so it
# gets its own test proving:
#   (a) systemd reaches running with the overlay store in place,
#   (b) /nix/store is OUR overlay mount (upper layer present),
#   (c) PID 1 survived (running store paths still visible through the lower),
#   (d) the bind-pinned lower is read-only,
#   (e) a runtime `nix build` succeeds and its output is in the UPPER, not the
#       baked lower,
#   (f) nix is configured with the local-overlay store.
#
# COMPOSE-ON-TOP note: in a VM the framework already overlays /nix/store
# (lowerdir=/nix/.ro-store, upperdir=/nix/.rw-store). Our module bind-pins THAT as
# our lower and stacks our own upper — exactly the same compose-on-top path that
# runs over a baked OCI store (Docker/k8s) or a bare host store (EC2/VM). So a
# green VM test exercises the real mechanism, just with an extra layer beneath.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-overlay-store";

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ sandboxModule ];

    programs.overlayStore.enable = true;

    # The test provides the writable upper as a tmpfs at upperPath — a stand-in
    # for the deployer-mounted volume (emptyDir/PVC in prod). Use systemd.mounts
    # (not fileSystems) so it yields a real .mount unit our overlay-store-setup
    # can order after via RequiresMountsFor — and so it isn't swallowed by the VM
    # framework's special handling of /nix/* fileSystems entries. Ordered early,
    # before our setup oneshot, with the same DefaultDependencies opt-out.
    systemd.mounts = [{
      what = "tmpfs";
      type = "tmpfs";
      where = config.programs.overlayStore.upperPath;
      wantedBy = [ "local-fs.target" ];
      before = [ "local-fs.target" ];
      unitConfig.DefaultDependencies = false;
    }];

    # Build OFFLINE inside the VM (no network): pin the `nixpkgs` registry to the
    # test's own nixpkgs source (a path-flake) and pre-seed it + hello's build
    # closure, so `nix build nixpkgs#hello` resolves and builds with no fetch. We
    # ship hello's inputDerivation (its build deps) but NOT its realised output, so
    # the build is real and must land in the upper.
    devEnvNix.nixpkgs = lib.mkForce "path:${pkgs.path}";
    nix.settings.substituters = lib.mkForce [ ];
    system.extraDependencies = [ pkgs.hello.inputDerivation pkgs.path ];

    # VM-FRAMEWORK RECONCILIATION (not needed in the OCI image, which ships a
    # populated /nix/var/nix/db and never runs register-nix-paths):
    #
    # The qemu-vm framework builds the Nix DB at boot via register-nix-paths
    # (`nix-store --load-db`). That command honours the global `store =
    # local-overlay://…read-only` we set, so it targets the read-only lower (whose
    # DB doesn't exist yet) and fails with "database does not exist, and cannot be
    # created in read-only mode". Two fixes, both test-only:
    #
    # (1) Force register-nix-paths to populate the BASE store DB (/nix/var/nix/db),
    #     bypassing our overlay store, by overriding `store` to a plain local store
    #     for just that unit. Our overlay's lower (root=/) then READS that DB.
    # (2) Order overlay-store-setup AFTER register-nix-paths so the base DB exists
    #     before we freeze the lower read-only and switch /nix/store to the overlay.
    systemd.services.register-nix-paths.environment.NIX_CONFIG = "store = local";
    systemd.services.overlay-store-setup = {
      after = [ "register-nix-paths.service" ];
      wants = [ "register-nix-paths.service" ];
      # register-nix-paths is `after local-fs.target`, but the module orders our
      # setup `before local-fs.target` — chaining them creates an ordering cycle
      # (setup → before local-fs → register → after local-fs → setup) that systemd
      # breaks by DELETING our unit. Drop the `before local-fs.target` edge in the
      # test (register-nix-paths already gates the DB); keep only the nix-daemon
      # ordering. The OCI image has no register-nix-paths, so the module's default
      # `before local-fs.target` stands there.
      before = lib.mkForce [ "nix-daemon.service" "nix-daemon.socket" ];
    };

    virtualisation.diskSize = 4096;
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.wait_for_unit("overlay-store-setup.service")
    machine.wait_for_unit("nix-daemon.socket")

    up = "/nix/.scooter-rw"
    lo = "/nix/.scooter-ro"

    # (a)(b) /nix/store is OUR overlay (the scooter upper layer is in the mount).
    mountinfo = machine.succeed("cat /proc/self/mountinfo")
    assert f"upperdir={up}/upper" in mountinfo, \
        f"/nix/store is not our overlay:\n{mountinfo}"

    # (c) systemd PID 1 survived the overlay; running store paths still visible.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    machine.succeed("ls /run/current-system/sw/bin >/dev/null")

    # (d) The bind-pinned lower is READ-ONLY (writes into it are denied).
    machine.fail(f"touch {lo}/canary 2>/dev/null")

    # (e) A real runtime `nix build` lands in the UPPER, not the lower. Build hello
    # (deps pre-seeded, output NOT pre-realised) and check the out path's basename
    # appears under the upper dir and NOT under the read-only lower.
    out = machine.succeed("nix build --no-link --print-out-paths nixpkgs#hello").strip()
    base = out.split('/')[-1]
    machine.succeed(f"test -e {up}/upper/{base}")
    machine.fail(f"test -e {lo}/{base} 2>/dev/null")
    # ...and the built tool actually runs (from the merged /nix/store view).
    machine.succeed(f"{out}/bin/hello >/dev/null")

    # (f) Nix sees the local-overlay store (the store setting took effect).
    store = machine.succeed("nix config show store")
    assert "local-overlay" in store, f"nix store is not local-overlay:\n{store}"
  '';
}
