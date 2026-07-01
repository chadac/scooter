# Test fixture: keep the nixosTest framework's `backdoor.service` (the driver's
# control channel) ALIVE across a scooter-apply-module switch.
#
# scooter-apply-module rebuilds the system toplevel from the SHARED base config
# (modules/sandbox-os), which doesn't include the framework-injected backdoor.
# switch-to-configuration then treats backdoor as a removed unit and STOPS it —
# the driver loses its connection and the test hangs. Layered into the re-converge
# via programs.scooterModule.extraReconvergeModules, this re-declares a
# `backdoor.service` in the rebuilt toplevel and marks it to NOT be stopped on
# reconfiguration, so the switch leaves the already-running backdoor untouched.
#
# Test-only: a real sandbox pod has no backdoor (and boot.isContainer forbids
# `testing.backdoor`), so production re-converge is unaffected.
{ lib, ... }:
{
  systemd.services.backdoor = {
    # Don't let the switch stop/restart the running backdoor — keep the test's
    # control channel up across the re-converge.
    restartIfChanged = false;
    stopIfChanged = false;
    unitConfig.X-StopOnReconfiguration = false;
    # A no-op definition so the unit is "present" in the new toplevel (the
    # framework's real backdoor is already running; we only need the switch to
    # see a same-named unit it's told to leave alone).
    serviceConfig.ExecStart = lib.mkDefault "/bin/true";
  };
}
