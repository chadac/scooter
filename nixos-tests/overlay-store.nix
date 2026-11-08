# nixosTest: the read-only-lower plus writable-upper Nix overlay store boots under
# systemd, the base store stays read-only, a path built at runtime lands in the
# upper, and a flake eval leaves no source copy there. The VM framework already overlays /nix/store; the module bind-pins that as
# its lower and stacks its own upper, the same compose-on-top path it takes over a
# baked OCI store, so the test exercises the real mechanism.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-overlay-store";

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ sandboxModule ];

    programs.overlayStore.enable = true;

    # A tmpfs stands in for the deployer-mounted upper volume; systemd.mounts yields a real .mount unit that overlay-store-setup can order after.
    systemd.mounts = [{
      what = "tmpfs";
      type = "tmpfs";
      where = config.programs.overlayStore.upperPath;
      wantedBy = [ "local-fs.target" ];
      before = [ "local-fs.target" ];
      unitConfig.DefaultDependencies = false;
    }];

    # Pin the registry to the test's nixpkgs and pre-seed hello's build deps but not its output, so the offline build is real and must land in the upper.
    devEnvNix.nixpkgs = lib.mkForce "path:${pkgs.path}";
    nix.settings.substituters = lib.mkForce [ ];
    system.extraDependencies = [ pkgs.hello.inputDerivation pkgs.path ];

    # VM-only reconciliation: the framework's register-nix-paths must populate the base store DB through a plain local store, and overlay-store-setup must run after it so the DB exists before the lower is frozen read-only.
    systemd.services.register-nix-paths.environment.NIX_CONFIG = "store = local";
    systemd.services.overlay-store-setup = {
      after = [ "register-nix-paths.service" ];
      wants = [ "register-nix-paths.service" ];
      # Keep only the nix-daemon ordering here, since `before local-fs.target` would form an ordering cycle with register-nix-paths.
      before = lib.mkForce [ "nix-daemon.service" "nix-daemon.socket" ];
    };

    # Stand in for a pooled upper returned by another sandbox: a foreign owner with its own roots and profile.
    systemd.services.seed-foreign-upper = {
      wantedBy = [ "overlay-store-setup.service" ];
      before = [ "overlay-store-setup.service" ];
      after = [ "nix-.scooter\\x2drw.mount" ];
      unitConfig.DefaultDependencies = false;
      # Stays active, so restarting overlay-store-setup does not re-seed it.
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      script = ''
        up=${config.programs.overlayStore.upperPath}
        mkdir -p $up/state/gcroots/auto $up/state/profiles/per-user/root
        echo conv-other > $up/.scooter-owner
        ln -s /workspace/result $up/state/gcroots/auto/foreign
        ln -s /nix/store/foreign-profile $up/state/profiles/per-user/root/profile-1-link
      '';
    };

    virtualisation.diskSize = 4096;
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.wait_for_unit("overlay-store-setup.service")
    machine.wait_for_unit("nix-daemon.socket")

    up = "/nix/.scooter-rw"
    lo = "/nix/.scooter-ro"

    # /nix/store is the module's overlay.
    mountinfo = machine.succeed("cat /proc/self/mountinfo")
    assert f"upperdir={up}/upper" in mountinfo, \
        f"/nix/store is not our overlay:\n{mountinfo}"

    # PID 1 survived the overlay and running store paths are still visible.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    machine.succeed("ls /run/current-system/sw/bin >/dev/null")

    # The bind-pinned lower is read-only.
    machine.fail(f"touch {lo}/canary 2>/dev/null")

    # A runtime `nix build` lands in the upper, not the lower.
    out = machine.succeed("nix build --no-link --print-out-paths nixpkgs#hello").strip()
    base = out.split('/')[-1]
    machine.succeed(f"test -e {up}/upper/{base}")
    machine.fail(f"test -e {lo}/{base} 2>/dev/null")
    # The built tool runs from the merged view.
    machine.succeed(f"{out}/bin/hello >/dev/null")

    # The foreign sandbox's roots and profile are gone, and this machine owns the upper.
    machine.succeed(f"test \"$(cat {up}/.scooter-owner)\" = machine")
    machine.succeed(f"test -z \"$(ls -A {up}/state/gcroots/auto)\"")
    machine.succeed(f"test -z \"$(ls -A {up}/state/profiles/per-user)\"")

    # Its own roots survive a re-run of the setup, since the owner now matches.
    machine.succeed(f"nix-store --realise {out} --add-root /root/result")
    machine.succeed("systemctl restart overlay-store-setup.service")
    machine.succeed(f"test -n \"$(ls -A {up}/state/gcroots/auto)\"")

    # A dirty-worktree flake eval copies no source into the store.
    machine.succeed(
        "mkdir /tmp/wt && cd /tmp/wt && git init -q"
        " && echo '{ outputs = _: { x = 1; }; }' > flake.nix"
        " && head -c 1048576 /dev/urandom > blob"
        " && git add . && git -c user.name=t -c user.email=t@t commit -qm init"
        " && echo changed >> blob"
    )
    before = machine.succeed(f"ls {up}/upper | grep -c -- '-source$' || true").strip()
    assert machine.succeed("nix eval /tmp/wt#x").strip() == "1"
    after = machine.succeed(f"ls {up}/upper | grep -c -- '-source$' || true").strip()
    assert before == after, f"flake eval copied source into the store ({before} -> {after})"

    # Nix is configured with the local-overlay store.
    store = machine.succeed("nix config show store")
    assert "local-overlay" in store, f"nix store is not local-overlay:\n{store}"
  '';
}
