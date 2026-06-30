# D-Bus that actually comes up — and survives a live switch — inside the pod.
#
# Two container-specific D-Bus problems, both diagnosed live in a k3d pod:
#
# 1. THE BUS NEVER REACHES `active`. Recent nixpkgs default the system bus to
#    `dbus-broker`, which runs as `Type=notify`: systemd waits for the broker's
#    `sd_notify(READY=1)` before marking the unit active. In this stripped
#    `boot.isContainer` environment that readiness signal doesn't reach systemd,
#    so `dbus-broker.service` sits in `activating (start)` FOREVER (the broker
#    process even exits 0 — it's the notify handshake that's missing, not a
#    crash). Every `systemd-run` / `busctl` / `StartTransientUnit` then fails
#    with "Transport endpoint is not connected", because the message bus is never
#    really up. Read-only `systemctl` still works (it uses systemd's private
#    socket, not the bus), which masks the problem.
#      -> Pin the CLASSIC `dbus` daemon. It doesn't depend on the notify handshake
#         that broker is failing here, so the bus reaches `active` normally.
#         (A bus that works > the broker's marginal perf win in a dev sandbox.)
#
# 2. A LIVE SWITCH RESTARTS THE BUS. When the agent self-modifies
#    (scooter-apply-module -> switch-to-configuration), the switch restarts every
#    changed unit. The system message bus + `systemd-logind` are pid1-critical;
#    under `boot.isContainer` there's no machine/login D-Bus to re-establish, so
#    restarting the bus mid-switch tears down the live bus the switch's own
#    detached scope (and every later apply) depends on.
#      -> Mark them restartIfChanged/stopIfChanged = false so a re-converge
#         applies their new config without stopping the running unit — the bus
#         keeps serving across the switch. Mirrors the protection already on
#         scooter-apply-module.service and the nixosTest backdoor fixture.
#
# Both are gated on `boot.isContainer`: in a nixosTest VM the bus comes up and
# restarts cleanly, so leave stock behavior there (and keep the VM exercising the
# real default).

{ config, lib, ... }:

let
  inContainer = config.boot.isContainer or false;

  # Units that must survive a live switch untouched — reload new config in place,
  # never stop+start during the switch.
  surviveSwitch = {
    restartIfChanged = false;
    stopIfChanged = false;
    unitConfig.X-StopOnReconfiguration = false;
  };
in
{
  config = lib.mkIf inContainer {
    # (1) Use the classic daemon so the bus actually reaches `active` in-pod.
    services.dbus.implementation = lib.mkForce "dbus";

    # (2) Don't let a re-converge restart the bus / logind out from under itself.
    systemd.services.dbus = surviveSwitch;
    systemd.services.systemd-logind = surviveSwitch;
  };
}
