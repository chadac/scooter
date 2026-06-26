# nixosTest: the sample systemd service comes up, and the agent can control it.
#
# Proves the "run real services" requirement end-to-end: the service reaches
# `active`, opens its port, and `systemctl stop`/`start` actually toggles it
# (the path the agent uses to enable a collaborative env on demand).
#
# RED until Stage 5 implements systemd.services.sample-dev-service.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-service";

  nodes.machine = { ... }: {
    imports = [ sandboxModule ];
    services.sampleDevService = { enable = true; port = 8888; };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # Comes up active + listening.
    machine.wait_for_unit("sample-dev-service.service")
    machine.wait_for_open_port(8888)
    machine.succeed("curl -fsS http://localhost:8888/ >/dev/null")

    # The agent-control path: stop -> port closed, start -> open again.
    machine.succeed("systemctl stop sample-dev-service.service")
    machine.wait_until_fails("curl -fsS http://localhost:8888/ >/dev/null")

    machine.succeed("systemctl start sample-dev-service.service")
    machine.wait_for_open_port(8888)
    machine.succeed("curl -fsS http://localhost:8888/ >/dev/null")
  '';
}
