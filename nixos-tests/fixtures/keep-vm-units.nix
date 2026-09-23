# Test fixture: reconcile the re-converged toplevel with the VM the test is
# switching, layered into EVERY re-converge via
# programs.scooterModule.extraReconvergeModules.
#
# THE GENERAL PROBLEM. scooter-apply-module rebuilds from the SHARED base config
# (modules/sandbox-os). In a POD that is also what booted, so the switch is a near
# no-op diff. In a VM the running system is the test FRAMEWORK's node config, so
# anything the base config does differently is a change the switch will act on —
# and some of those changes break the switch, the test, or both. Each case below
# cost a debugging round; keep them documented.
#
# Test-only: a pod's booted system IS this base config.

{ lib, ... }:
{
  # (1) The driver's control channel. The base config has no `backdoor.service`, so
  # the switch would stop it as a removed unit, the driver would lose the VM, and
  # `machine.succeed("scooter-apply-module")` would HANG to the 1h timeout. Declaring
  # it here keeps it out of the stop list; the flags keep the switch off the running
  # one. (A no-op definition on purpose — the real unit is already running, we only
  # need the switch to see a same-named unit it is told to leave alone.)
  systemd.services.backdoor = {
    restartIfChanged = false;
    stopIfChanged = false;
    unitConfig.X-StopOnReconfiguration = false;
    serviceConfig.ExecStart = lib.mkDefault "/bin/true";
  };

  # (2) The boot-apply unit must stay OFF, as the node asked. The node sets
  # applyOnBoot = false so the test can drive the converge explicitly and assert the
  # before/after states — but base-config.nix force-enables programs.scooterModule
  # for the re-converge and applyOnBoot defaults true, so the rebuilt toplevel gains
  # a scooter-apply-module.service the running system never had. The switch starts it
  # as a NEW unit, mid-switch; it refuses (one converge at a time) and FAILS, and
  # scooter-apply-module reads that new failed unit as its own failure and ROLLS BACK
  # a switch that had in fact applied cleanly. In a pod the unit already exists and is
  # the thing running the switch, so it is protected as a *changed* unit instead and
  # never restarts. Why: PR #610.
  programs.scooterModule.applyOnBoot = lib.mkForce false;

  # (3) No gettys on the driver's console. The framework's test-instrumentation.nix
  # disables these because the driver talks to the guest over ttyS0/hvc0 in a base64
  # protocol; the base config does not, so the switch STARTS them and a login prompt
  # is interleaved into that stream — the driver dies on `binascii.Error: Incorrect
  # padding` with the switch itself having worked. Same list as the framework's.
  systemd.services."serial-getty@ttyS0".enable = false;
  systemd.services."serial-getty@hvc0".enable = false;
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@".enable = false;
}
