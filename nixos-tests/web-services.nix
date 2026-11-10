# nixosTest: the webServices option renders a proxyable unit and the discovery
# manifest, honours explicit start, and serves under its base path. A fake python
# http.server stands in for a real web service so the VM stays hermetic. This is
# the contract the agent-host WebServiceRegistry and proxy rely on:
# /run/scooter/web-services.json lists { name, port, basePath, unit }, the unit is
# not auto-started, and `systemctl start webservice-<name>` brings it up on its port.

{ pkgs, lib, sandboxModule }:

let
  # A tiny sub-path-aware server: 200 under its prefix + /demo/, 404 elsewhere, reading
  # SCOOTER_SERVICE_PREFIX from the unit env like the real services.
  demoServer = pkgs.writeShellScript "demo-web-service" ''
    set -euo pipefail
    base="''${SCOOTER_SERVICE_PREFIX-/c/''${CONVERSATION_ID:-unknown}}/demo"
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

  # `machine` has no sandbox domain (services under /c/<id>/); `origin` has its own
  # services origin, as the provisioner injects with SANDBOX_DOMAIN set (services at /<name>/).
  nodes.origin = { lib, ... }: {
    imports = [ sandboxModule ];
    boot.kernelParams = [
      "CONVERSATION_ID=5a515e73-860b-49ba-bc3f-6ff8d5fda5ff"
      "SCOOTER_SERVICES_ORIGIN=https://5a515e73.scooter.example.com"
      "CONVERSATION_URL=https://scooter.example.com/c/5a515e73-860b-49ba-bc3f-6ff8d5fda5ff"
    ];
    webServices.demo = { enable = true; port = 9911; displayName = "Demo"; command = "${demoServer}"; };
    webServices.ssh.enable = true;
    # "Demo + chat", as marimo's notebook frames marimo.
    webServices.demo-chat = { enable = true; port = 9913; displayName = "Demo"; chatPage.app = "../demo/"; };
  };

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];

    # Unrecognised kernel cmdline args land on PID 1's environ but not in the systemd manager env, reproducing how the container runtime delivers CONVERSATION_ID in production.
    boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];

    # The built-in `terminal` is enabled to assert its declaration only; starting it would `nix build` ttyd inside the VM.
    webServices.terminal.enable = true;

    webServices.demo = {
      enable = true;
      port = 9911;
      displayName = "Demo";
      command = "${demoServer}";
      hint = "Reload the demo after editing it.";
      # No environment.CONVERSATION_ID: the module must source it from PID 1's environ.
      # Arbitrary systemd config merged into the unit.
      extraConfig = {
        unitConfig.X-Web-Service-Test = "yes";
        serviceConfig.LimitNOFILE = 4242;
        wants = [ "webservice-backend.service" ];
      };
    };

    # An unlisted backend the demo starts, as marimo is to "marimo + chat" (notebook).
    webServices.backend = {
      enable = true;
      port = 9912;
      visibleInMenu = false;
      command = "${pkgs.coreutils}/bin/sleep infinity";
      extraConfig.partOf = [ "webservice-demo.service" ];
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # 1. The discovery manifest lists the service.
    manifest = machine.succeed("cat /run/scooter/web-services.json")
    import json
    data = json.loads(manifest)
    svc = { s["name"]: s for s in data["services"] }["demo"]
    assert svc["port"] == 9911, svc
    assert svc["unit"] == "webservice-demo", svc
    assert svc["basePath"].endswith("/demo"), svc

    # 1b. The service's port is open in the firewall, which the loopback curls below never exercise.
    machine.succeed("systemctl is-active --quiet firewall")
    machine.succeed("iptables -S nixos-fw | grep -E -- '--dport 9911 .*-j nixos-fw-accept'")

    # 2. Explicit start: the unit exists but is not running until asked.
    machine.succeed("systemctl cat webservice-demo.service >/dev/null")
    machine.fail("systemctl is-active --quiet webservice-demo.service")

    # extraConfig merged into the unit.
    unit = machine.succeed("systemctl cat webservice-demo.service")
    assert "X-Web-Service-Test=yes" in unit, unit
    assert "LimitNOFILE=4242" in unit, unit
    machine.fail("curl -fsS http://localhost:9911/c/conv-test/demo/ >/dev/null")

    # 2b. CONVERSATION_ID is on PID 1's environ but not declared by the unit, so a working base path can only come from the module recovering it from /proc/1/environ.
    machine.succeed("tr '\\0' '\\n' < /proc/1/environ | grep -q '^CONVERSATION_ID=conv-test'")
    assert "CONVERSATION_ID" not in machine.succeed("systemctl cat webservice-demo.service"), "must not be in the unit env"

    # 3. Start it, as the agent-host does via exec.
    machine.succeed("systemctl start webservice-demo.service")
    machine.wait_for_open_port(9911)

    # 4. Serves under the base path and 404s outside it.
    machine.succeed("curl -fsS http://localhost:9911/c/conv-test/demo/ | grep -q demo-ok")
    machine.succeed("test $(curl -s -o /dev/null -w '%{http_code}' http://localhost:9911/other) = 404")

    # 4b. The scooter-service CLI drives the units without a rebuild.
    machine.succeed("command -v scooter-service")
    machine.succeed("scooter-service list | grep -q demo")
    # Without a services origin the URL is the main-host path.
    machine.succeed("scooter-service list | grep -qF '/c/conv-test/demo/'")
    machine.succeed("scooter-service status demo | grep -q active")
    # The service's hint reaches the agent on status and start, one `note:` per line.
    machine.succeed("scooter-service status demo | grep -qx 'note: Reload the demo after editing it.'")
    machine.succeed("scooter-service stop demo")
    machine.succeed("! systemctl is-active --quiet webservice-demo.service")
    out = machine.succeed("scooter-service start demo")
    assert "url: /c/conv-test/demo/" in out and "note: Reload the demo after editing it." in out, out
    machine.wait_until_succeeds("systemctl is-active --quiet webservice-demo.service", timeout=30)
    machine.fail("scooter-service start nope")

    # 4c. An unlisted service is in the manifest (the proxy needs its port) but not in
    #     `list`; it starts with the service that wants it, answers status by name, and
    #     stops with the service it is PartOf.
    services = { s["name"]: s for s in data["services"] }
    assert services["backend"].get("visibleInMenu") is False, services["backend"]
    assert "visibleInMenu" not in services["demo"], services["demo"]
    machine.succeed("! scooter-service list | grep -q backend")
    machine.wait_until_succeeds("systemctl is-active --quiet webservice-backend.service", timeout=30)
    machine.succeed("scooter-service status backend | grep -q active")
    machine.succeed("scooter-service stop demo")
    machine.wait_until_succeeds("! systemctl is-active --quiet webservice-backend.service", timeout=30)

    # 5. The built-in `terminal` is in the manifest and its unit runs ttyd + tmux under the /terminal base path.
    term = { s["name"]: s for s in data["services"] }["terminal"]
    assert term["unit"] == "webservice-terminal", term
    assert term["basePath"].endswith("/terminal"), term
    # The wrapper's store path appears twice in the ExecStart value, so take the first.
    exec_start = machine.succeed(
        "systemctl show webservice-terminal.service -p ExecStart --value "
        "| grep -oE '/nix/store/[a-z0-9]+-terminal-web-service' | head -1"
    ).strip()
    wrapper = machine.succeed(f"cat '{exec_start}'")
    assert "ttyd" in wrapper and "tmux" in wrapper, wrapper
    assert "--base-path" in wrapper and "--writable" in wrapper, wrapper
    machine.fail("systemctl is-active --quiet webservice-terminal.service")

    # 6. On its own services origin a service serves at /<name>/, and the CLI hands out
    #    the absolute origin URL.
    origin.wait_for_unit("default.target")
    origin.succeed("systemctl start webservice-demo.service")
    origin.wait_for_open_port(9911)
    origin.succeed("curl -fsS http://localhost:9911/demo/ | grep -q demo-ok")
    origin.succeed("test $(curl -s -o /dev/null -w '%{http_code}' http://localhost:9911/c/5a515e73-860b-49ba-bc3f-6ff8d5fda5ff/demo/) = 404")
    origin.succeed("grep -qx 'SCOOTER_SERVICE_PREFIX=' /run/webservice-demo/conv.env")
    url = origin.succeed("scooter-service start demo | sed -n 's/^url: //p'").strip()
    assert url == "https://5a515e73.scooter.example.com/demo/", url

    # 6b. chatPage builds the chat URL from CONVERSATION_URL and CONVERSATION_ID.
    origin.succeed("scooter-service start demo-chat")
    origin.wait_for_open_port(9913)
    page = origin.succeed("curl -fsS http://localhost:9913/")
    assert '"chatUrl":"https://scooter.example.com/chat/5a515e73-860b-49ba-bc3f-6ff8d5fda5ff"' in page, page
    assert '"app":"../demo/"' in page and '"storageKey":"demo-chat"' in page, page
    assert "window.ChatPage" in page and "<title>Demo</title>" in page, page
    assert "@CONFIG@" not in page and "@CHAT_PAGE@" not in page, page

    # 7. The built-in `ssh` takes any client key over its WebSocket, as root, with a
    #    host key kept on the workspace PVC.
    origin.succeed("systemctl start webservice-ssh.service")
    origin.wait_for_open_port(2222)
    origin.succeed("${pkgs.openssh}/bin/ssh-keygen -q -t ed25519 -N \'\' -f /tmp/client")
    ssh = (
        "${pkgs.openssh}/bin/ssh -F none -i /tmp/client -o IdentitiesOnly=yes "
        "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "
        "-o 'ProxyCommand=${pkgs.websocat}/bin/websocat --binary ws://127.0.0.1:2222/ssh/' "
    )
    out = origin.succeed(ssh + "-l root sandbox 'id -un'")
    assert out.strip() == "root", out
    origin.succeed("test -s /workspace/.scooter/ssh/ssh_host_ed25519_key")
    # Only root: the key command authorizes nobody else.
    origin.fail(ssh + "-o BatchMode=yes -l nobody sandbox true")
  '';
}
