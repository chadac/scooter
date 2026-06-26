# nixosTest: the sandbox-os config boots as a real systemd system.
#
# This is the foundation: if systemd PID 1 + the base config don't boot cleanly,
# nothing else matters. Asserts default.target is reached, journald is up, and
# the system is not in an offline/failed state.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-systemd-boot";

  nodes.machine = { ... }: {
    imports = [ sandboxModule ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # journald is up (logging works).
    machine.wait_for_unit("systemd-journald.service")
    machine.succeed("journalctl --no-pager -n 1")

    # The system booted into a usable state (running or degraded — NOT offline,
    # and the manager is actually systemd).
    state = machine.succeed("systemctl is-system-running || true").strip()
    assert state in ("running", "degraded"), f"unexpected system state: {state}"

    # nix is usable in-pod (the agent builds/installs on demand): the daemon is
    # up and `nix` evaluates.
    machine.wait_for_unit("nix-daemon.socket")
    machine.succeed("nix --version")
  '';
}
