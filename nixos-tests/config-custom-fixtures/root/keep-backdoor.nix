# Test fixture: keep the nixosTest framework's `backdoor.service` (the driver's control channel)
# ALIVE across a scooter-rebuild switch.
#
# scooter-rebuild builds the toplevel from config/root (this stand-in), which does NOT include the
# framework-injected backdoor. switch-to-configuration then treats backdoor as a REMOVED unit and
# STOPS it — the driver loses its connection and a synchronous `machine.succeed("scooter-rebuild
# switch")` hangs to the test timeout. Importing this re-declares a same-named `backdoor.service`
# in the rebuilt toplevel + marks it to NOT be stopped on reconfiguration, so the switch leaves the
# already-running backdoor untouched.
#
# Self-contained COPY (not an import of ../../fixtures/keep-backdoor.nix): config/root is delivered
# as a standalone store-path dir at runtime, so it must not reach outside itself. Test-only — a
# real pod has no backdoor.
{ lib, ... }:
{
  systemd.services.backdoor = {
    restartIfChanged = false;
    stopIfChanged = false;
    unitConfig.X-StopOnReconfiguration = false;
    serviceConfig.ExecStart = lib.mkDefault "/bin/true";
  };
}
