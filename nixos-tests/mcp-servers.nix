# nixosTest: the mcpServers option renders a unit + the discovery manifest,
# auto-assigns ports, mints a bearer token, and binds loopback by default.
#
# Uses FAKE MCP servers (a python http.server) rather than a real one, so the VM
# stays hermetic — no lazy `uv tool run mcp-proxy` fetch inside the test. What is
# under test is the MODULE's contract with the agent-host McpServerRegistry, not
# any particular MCP implementation.

{ pkgs, lib, sandboxModule }:

let
  # Answers 200 on /mcp, echoing the conversation id so we can prove the unit
  # recovered CONVERSATION_ID from PID 1's environ. Binds the address+port it is
  # told, so the loopback-by-default claim is testable.
  fakeServer = pkgs.writeShellScript "fake-mcp-server" ''
    set -euo pipefail
    exec ${pkgs.python3}/bin/python3 - "$1" "$2" <<'PY'
    import os, sys
    from http.server import BaseHTTPRequestHandler, HTTPServer
    addr, port = sys.argv[1], int(sys.argv[2])
    conv = os.environ.get("CONVERSATION_ID", "unset")
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/mcp":
                self.send_response(200); self.end_headers()
                self.wfile.write(b"mcp-ok:" + conv.encode())
            else:
                self.send_response(404); self.end_headers()
        def log_message(self, *a): pass
    HTTPServer((addr, port), H).serve_forever()
    PY
  '';
in
pkgs.testers.runNixOSTest {
  name = "dev-env-mcp-servers";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];

    # `ss` for the bind-address assertions. Declared HERE rather than assumed: it is
    # not in the sandbox image's systemPackages, and the loopback-bind check is the
    # security property this test exists to prove — it must not silently skip.
    environment.systemPackages = [ pkgs.iproute2 ];

    # Same container-env reproduction the web-services test uses: the kernel passes
    # unrecognized key=VALUE cmdline args to INIT's environment, so CONVERSATION_ID
    # lands on /proc/1/environ but NOT in the systemd manager env. The module must
    # recover it, so we deliberately do not set it in the unit environment.
    boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];

    # A web service alongside, so the test proves the two port spaces really are
    # disjoint (ttyd 7681 vs the 9700 MCP base) rather than trusting the assertion,
    # and gives the restartIfChanged contrast in step 6 something to compare against.
    # Declaration only — ttyd is a lazy tool we must not build inside the VM.
    webServices.terminal.enable = true;

    # Two auto-port servers ("alpha" < "beta" -> 9700, 9701) and one explicit, to
    # prove assignment is by sorted index and that the two kinds coexist.
    mcpServers.alpha = {
      enable = true;
      description = "Alpha test server";
      command = "${fakeServer} 127.0.0.1 9700";
      extraConfig.unitConfig.X-Mcp-Test = "yes";
    };
    mcpServers.beta = {
      enable = true;
      command = "${fakeServer} 127.0.0.1 9701";
      autoStart = false;
    };
    mcpServers.gamma = {
      enable = true;
      port = 9911;
      command = "${fakeServer} 127.0.0.1 9911";
      autoStart = false;
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    import json
    data = json.loads(machine.succeed("cat /run/scooter/mcp-servers.json"))
    srv = { s["name"]: s for s in data["servers"] }

    # 1. Ports are AUTO-ASSIGNED by sorted index from the 9700 base, and an
    #    explicit port is left alone.
    assert srv["alpha"]["port"] == 9700, srv
    assert srv["beta"]["port"] == 9701, srv
    assert srv["gamma"]["port"] == 9911, srv
    assert srv["alpha"]["unit"] == "mcp-alpha", srv
    assert srv["alpha"]["description"] == "Alpha test server", srv
    assert srv["alpha"]["path"] == "/mcp", srv

    # 2. The manifest carries NO credential. Access control here is the loopback
    #    bind (asserted in 4), not a secret — a token nothing enforces would read as
    #    auth without being it. One belongs with the proxy that checks it, if and
    #    when a server is exposed off-loopback.
    assert "token" not in json.dumps(data).lower(), data

    # 3. autoStart: alpha is up on its own; beta/gamma are declared but not started
    #    (the agent has no way to know it must start a server first, so the DEFAULT
    #    is on — but the option has to actually work).
    machine.wait_for_unit("mcp-alpha.service")
    machine.wait_for_open_port(9700)
    machine.fail("systemctl is-active --quiet mcp-beta.service")
    machine.fail("systemctl is-active --quiet mcp-gamma.service")

    # 4. LOOPBACK BY DEFAULT + firewall closed. These pods have no NetworkPolicy, so
    #    a 0.0.0.0 bind would publish the agent's tools to every pod that can route
    #    here. Assert both halves: nothing listening off-loopback, and no accept rule.
    machine.succeed("ss -ltn | grep -q '127.0.0.1:9700'")
    machine.fail("ss -ltn | grep -qE '0\\.0\\.0\\.0:9700|\\*:9700'")
    machine.succeed("systemctl is-active --quiet firewall")
    machine.fail("iptables -S nixos-fw | grep -E -- '--dport 9700 .*-j nixos-fw-accept'")

    # 5. It serves, and CONVERSATION_ID was recovered from /proc/1/environ (the unit
    #    does not declare it, so "conv-test" can only have come from the ExecStartPre).
    machine.succeed("curl -fsS http://127.0.0.1:9700/mcp | grep -q 'mcp-ok:conv-test'")
    assert "CONVERSATION_ID" not in machine.succeed("systemctl cat mcp-alpha.service")

    # extraConfig is merged over the generated unit.
    assert "X-Mcp-Test=yes" in machine.succeed("systemctl cat mcp-alpha.service")

    # 6. The unit must NOT opt out of restart-on-change the way webServices does
    #    (X-RestartIfChanged=false): an auto-assigned port can be renumbered by a
    #    rebuild, and a server that does not rebind leaves the manifest advertising a
    #    port nothing is listening on.
    assert "X-RestartIfChanged=false" not in machine.succeed("systemctl cat mcp-alpha.service")
    assert "X-RestartIfChanged=false" in machine.succeed("systemctl cat webservice-terminal.service")

    # 7. scooter-mcp drives the units without a rebuild, and persists intent to the
    #    workspace PVC so the boot restore brings them back after a resume.
    machine.succeed("command -v scooter-mcp")
    machine.succeed("scooter-mcp list | grep -q alpha")
    machine.succeed("scooter-mcp status alpha | grep -q active")
    machine.succeed("scooter-mcp start beta")
    machine.wait_until_succeeds("systemctl is-active --quiet mcp-beta.service", timeout=30)
    machine.succeed("grep -q beta /workspace/.scooter/mcp.json")
    machine.succeed("scooter-mcp stop beta")
    machine.fail("grep -q beta /workspace/.scooter/mcp.json")   # stopped => not restored
    machine.fail("scooter-mcp start nope")                      # unknown => non-zero

    # 8. restore() re-starts what was running before a pod recreate.
    machine.succeed("scooter-mcp start beta")
    machine.succeed("systemctl stop mcp-beta.service")
    machine.succeed("scooter-mcp restore")
    machine.wait_until_succeeds("systemctl is-active --quiet mcp-beta.service", timeout=30)
  '';
}
