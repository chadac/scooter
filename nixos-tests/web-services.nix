# nixosTest: the webServices option renders a proxyable unit + the
# discovery manifest, honours explicit-start, and serves under its base path.
#
# Uses a FAKE web service (a python http.server under a base path) rather than the
# marimo built-in, so the VM stays hermetic (no lazy `nix build marimo` inside the
# test). Proves the contract the agent-host WebServiceRegistry + proxy rely on:
#   - /run/scooter/web-services.json lists { name, port, basePath, unit }
#   - the unit is NOT auto-started (explicit-start model)
#   - `systemctl start webservice-<name>` brings it up, listening on its port
#   - it serves content under the declared basePath (sub-path serving)

{ pkgs, lib, sandboxModule }:

let
  # A tiny sub-path-aware server: 200 only under /c/<id>/demo/, 404 elsewhere —
  # stands in for marimo --base-url. Reads CONVERSATION_ID from the env like the
  # real services do.
  demoServer = pkgs.writeShellScript "demo-web-service" ''
    set -euo pipefail
    base="/c/''${CONVERSATION_ID:-unknown}/demo"
    exec ${pkgs.python3}/bin/python3 - "$base" <<'PY'
    import sys
    from http.server import BaseHTTPRequestHandler, HTTPServer
    base = sys.argv[1]
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith(base):
                self.send_response(200); self.end_headers(); self.wfile.write(b"demo-ok")
            else:
                self.send_response(404); self.end_headers()
        def log_message(self, *a): pass
    HTTPServer(("0.0.0.0", 9911), H).serve_forever()
    PY
  '';
in
pkgs.testers.runNixOSTest {
  name = "dev-env-web-services";

  nodes.machine = { ... }: {
    imports = [ sandboxModule ];
    # The built-in `terminal` (ttyd + tmux) — enabled to prove it RENDERS a proxyable
    # unit + manifest entry. NOT started here (ttyd is a lazy tool that would `nix build`
    # inside the VM); we only assert the declaration, like a marimo/vscode would.
    webServices.terminal.enable = true;
    webServices.terminal.environment.CONVERSATION_ID = "conv-test";

    webServices.demo = {
      enable = true;
      port = 9911;
      displayName = "Demo";
      command = "${demoServer}";
      # In production the provisioner injects CONVERSATION_ID as a pod-wide env var
      # (visible to systemd units); a nixosTest `environment.variables` is only a
      # login-shell var, so pass it through the unit env to mirror production.
      environment.CONVERSATION_ID = "conv-test";
      # extraConfig escape hatch: arbitrary generic systemd config merged into the
      # unit (proves the deferredModule merge).
      extraConfig = {
        unitConfig.X-Web-Service-Test = "yes";
        serviceConfig.LimitNOFILE = 4242;
      };
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # 1. Discovery manifest lists the service (the agent-host reads this).
    manifest = machine.succeed("cat /run/scooter/web-services.json")
    import json
    data = json.loads(manifest)
    svc = { s["name"]: s for s in data["services"] }["demo"]
    assert svc["port"] == 9911, svc
    assert svc["unit"] == "webservice-demo", svc
    assert svc["basePath"].endswith("/demo"), svc

    # 2. Explicit-start: the unit exists but is NOT running until asked.
    machine.succeed("systemctl cat webservice-demo.service >/dev/null")
    machine.fail("systemctl is-active --quiet webservice-demo.service")

    # extraConfig (deferredModule) merged into the unit.
    unit = machine.succeed("systemctl cat webservice-demo.service")
    assert "X-Web-Service-Test=yes" in unit, unit
    assert "LimitNOFILE=4242" in unit, unit
    machine.fail("curl -fsS http://localhost:9911/c/conv-test/demo/ >/dev/null")

    # 3. Start it (the agent-host does this via exec on the UI Start button).
    machine.succeed("systemctl start webservice-demo.service")
    machine.wait_for_open_port(9911)

    # 4. Serves under the base path; 404 outside it (sub-path serving).
    machine.succeed("curl -fsS http://localhost:9911/c/conv-test/demo/ | grep -q demo-ok")
    machine.succeed("test $(curl -s -o /dev/null -w '%{http_code}' http://localhost:9911/other) = 404")

    # 5. The built-in `terminal` renders correctly (declaration only — not started, so no
    #    lazy ttyd build in the VM). It's in the manifest and its unit runs ttyd + tmux
    #    under the /terminal base path.
    term = { s["name"]: s for s in data["services"] }["terminal"]
    assert term["unit"] == "webservice-terminal", term
    assert term["basePath"].endswith("/terminal"), term
    # ExecStart points at the terminal wrapper script; its CONTENTS run ttyd + tmux under
    # the /terminal base path, writable. Resolve the store path (appears twice in the
    # ExecStart value — path= + argv[0]) with `head -1`, then read the body.
    exec_start = machine.succeed(
        "systemctl show webservice-terminal.service -p ExecStart --value "
        "| grep -oE '/nix/store/[a-z0-9]+-terminal-web-service' | head -1"
    ).strip()
    wrapper = machine.succeed(f"cat '{exec_start}'")
    assert "ttyd" in wrapper and "tmux" in wrapper, wrapper
    assert "--base-path" in wrapper and "--writable" in wrapper, wrapper
    machine.fail("systemctl is-active --quiet webservice-terminal.service")  # explicit-start
  '';
}
