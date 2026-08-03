# nixosTest: an ENABLED web service is remembered across a reboot.
#
# The bug this locks down: web-service units are explicit-start (NOT wantedBy
# multi-user.target), so when a Sandbox hibernates and the pod is recreated, every
# service that was running comes back DEAD — and the proxy 502s ("upstream failed").
#
# The fix has two in-pod halves, both asserted here:
#   1. `scooter-service start/stop <name>` records the enabled set in a state file
#      on the workspace PVC: /workspace/.scooter/services.json
#        { "enabled": { "<name>": { "since": "...", "autostart": true } } }
#      (the PVC survives suspend/resume, so the state survives the pod recreate).
#   2. a `scooter-service-restore` boot oneshot (wantedBy multi-user.target) reads
#      that file and `systemctl start webservice-<name>` for each autostart service.
#
# We simulate the pod recreate with `systemctl restart scooter-service-restore` (the
# oneshot re-runs EXACTLY as it does on a fresh boot) and assert the service is active
# again WITHOUT anyone re-issuing a start — and, conversely, that a deliberately-
# stopped service is NOT brought back. The end-to-end "survives a real PVC across
# suspend/resume" guarantee is the Tier-2 k3d suspend-resume test (a VM `reboot()`
# resets machine state, so it can't model the PVC that carries the state file).
#
# Uses a FAKE sub-path server (like web-services.nix) so the VM stays hermetic.

{ pkgs, lib, sandboxModule }:

let
  demoServer = pkgs.writeShellScript "demo-web-service" ''
    set -euo pipefail
    exec ${pkgs.python3}/bin/python3 - <<'PY'
    from http.server import BaseHTTPRequestHandler, HTTPServer
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(b"demo-ok")
        def log_message(self, *a): pass
    HTTPServer(("0.0.0.0", 9911), H).serve_forever()
    PY
  '';
in
pkgs.testers.runNixOSTest {
  name = "dev-env-service-persist";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];
    boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];

    webServices.demo = {
      enable = true;
      port = 9911;
      displayName = "Demo";
      command = "${demoServer}";
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    import json

    # State file lives on the workspace PVC (here just /workspace on the VM disk).
    STATE = "/workspace/.scooter/services.json"

    # --- 0. Explicit-start: nothing running, no state yet. ---------------------
    machine.fail("systemctl is-active --quiet webservice-demo.service")

    # --- 1. `scooter-service start` records the enabled set. -------------------
    machine.succeed("scooter-service start demo")
    machine.wait_until_succeeds("systemctl is-active --quiet webservice-demo.service", timeout=30)

    state = json.loads(machine.succeed(f"cat {STATE}"))
    assert "demo" in state.get("enabled", {}), state
    assert state["enabled"]["demo"].get("autostart") is True, state

    # --- 2. Simulate the pod recreate: stop the unit (as a fresh pod would have
    #        it dead), then run the restore oneshot exactly as boot does. --------
    machine.succeed("systemctl stop webservice-demo.service")
    machine.fail("systemctl is-active --quiet webservice-demo.service")

    machine.succeed("systemctl restart scooter-service-restore.service")
    machine.wait_until_succeeds("systemctl is-active --quiet webservice-demo.service", timeout=30)
    # is-active fires when the unit starts, but the python server binds the socket a
    # beat later — wait for the port, then assert it actually serves.
    machine.wait_for_open_port(9911)
    machine.succeed("curl -fsS http://localhost:9911/ | grep -q demo-ok")

    # --- 3. `scooter-service stop` clears autostart (a real reboot must NOT
    #        bring back a service the user deliberately stopped). ---------------
    machine.succeed("scooter-service stop demo")
    state = json.loads(machine.succeed(f"cat {STATE}"))
    # Either removed from `enabled`, or present with autostart=false — both are
    # valid encodings of "don't restore this".
    demo = state.get("enabled", {}).get("demo")
    assert demo is None or demo.get("autostart") is False, state

    # --- 4. A deliberately-stopped service is NOT restored on the next boot. ----
    #        (part 3 cleared demo's autostart; the restore oneshot must skip it.)
    machine.succeed("systemctl restart scooter-service-restore.service")
    machine.sleep(1)
    machine.fail("systemctl is-active --quiet webservice-demo.service")

    # --- 5. The restore unit is wired into boot (wantedBy multi-user.target) and
    #        succeeded on THIS boot — so a real pod recreate runs it automatically.
    #        (The end-to-end "survives a real PVC across suspend/resume" guarantee
    #        is the Tier-2 k3d suspend-resume test; here we assert the boot wiring +
    #        the restore logic hermetically. A VM `reboot()` can't model the PVC.)
    machine.succeed("systemctl show scooter-service-restore.service -p WantedBy --value "
                    "| grep -q multi-user.target")
    machine.succeed("systemctl show scooter-service-restore.service -p Result --value | grep -q success")
  '';
}
