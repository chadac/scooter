# nixosTest: contrib/web-review's sandbox half, booted. The proxy and CLI are covered
# by their Go tests and the overlay by tests/ui/review.ui.mjs; what only a VM shows is
# the wiring: Review is off until webReview.target is set, `review target` writes that
# module and rebuilds, and a target's dev server (`run`) or the agent's own unit
# (`unit`) starts and stops with Review, served under the base path with the overlay.

{ pkgs, lib, sandboxModule }:

let
  serve = "${pkgs.python3}/bin/python3 ${../contrib/web-review/example}/serve.py";
  common = {
    imports = [ sandboxModule ../contrib/web-review/sandbox.nix ];
    boot.kernelParams = [ "CONVERSATION_ID=conv-review" ];
    # Headless screenshots need chromium, which this test doesn't exercise.
    webReview.chromium = null;
    systemd.tmpfiles.rules = [ "d /workspace 0755 root root -" ];
    environment.systemPackages = [ pkgs.curl ];
  };
  # Records the calls `review target` makes; the VM has no scooter-rebuild.
  recorder = name: pkgs.writeShellScriptBin name ''echo "${name} $*" >> /tmp/calls'';
in
pkgs.testers.runNixOSTest {
  name = "dev-env-contrib-web-review";

  nodes = {
    # As shipped: no target, so Review is off.
    off = {
      imports = [ common ];
      environment.systemPackages = [ (recorder "scooter-rebuild") (recorder "scooter-service") ];
    };
    # What `review target --run … --port 5173` writes.
    run = {
      imports = [ common ];
      webReview.target = {
        port = 5173;
        run = ''${serve} --port 5173 --base "$REVIEW_BASE"'';
        cwd = "/workspace";
      };
    };
    # What `review target --unit acme --port 5174` writes, beside the agent's unit.
    unit = {
      imports = [ common ];
      systemd.services.acme.serviceConfig.ExecStart = "${serve} --port 5174 --base /c/conv-review/review-app/";
      webReview.target = { port = 5174; unit = "acme.service"; };
    };
  };

  testScript = ''
    import json

    base = "/c/conv-review"

    def serves_app(m, route):
        page = m.wait_until_succeeds(
            f"curl -fsS -D /tmp/headers -H 'Sec-Fetch-Dest: iframe' http://localhost:2732{base}/review-app{route}"
        )
        assert f'<script src="{base}/review-app/__review/overlay.js"' in page, page[:500]
        assert f'<base href="{base}/review-app/">' in page, page[:500]
        headers = m.succeed("cat /tmp/headers").lower()
        assert "x-frame-options" not in headers, headers
        assert "frame-ancestors" not in headers, headers

    # 1. Off: no units, not in the manifest; `review target` writes the module, rebuilds
    # and restarts Review, and --clear removes the module and rebuilds.
    off.wait_for_unit("default.target")
    off.fail("grep -qs '\"review\"' /run/scooter/web-services.json")
    off.fail("systemctl cat webservice-review")
    assert "no app to review yet" in off.fail("review list 2>&1")
    off.succeed("mkdir -p /workspace/my-app && cd /workspace/my-app && review target --run 'npm run dev' --port 5173 >&2")
    module = off.succeed("cat /etc/scooter/modules/web-review-target.nix")
    assert 'run = "npm run dev";' in module and 'cwd = "/workspace/my-app";' in module, module
    off.succeed("nix-instantiate --parse /etc/scooter/modules/web-review-target.nix >&2")
    calls = off.succeed("cat /tmp/calls")
    assert calls == "scooter-rebuild switch\nscooter-service restart review\n", calls
    off.succeed("review target --clear")
    off.fail("test -e /etc/scooter/modules/web-review-target.nix")
    off.shutdown()

    # 2. run: Review is listed, review-app isn't; starting Review starts the proxy and
    # runs the dev server as its own unit, with the base path in its environment.
    run.wait_for_unit("default.target")
    data = {s["name"]: s for s in json.loads(run.succeed("cat /run/scooter/web-services.json"))["services"]}
    assert "visibleInMenu" not in data["review"], data["review"]
    assert data["review-app"]["visibleInMenu"] is False, data["review-app"]
    listing = run.succeed("scooter-service list")
    assert "review " in listing and "review-app" not in listing, listing
    run.succeed("scooter-service start review")
    run.wait_for_unit("webservice-review-app.service")
    run.wait_for_unit("webservice-review-dev.service")
    serves_app(run, "/orders/1042")
    run.succeed(f"curl -fsS http://localhost:2732{base}/review-app/__review/vendor/modern-screenshot.js | grep -q modernScreenshot")

    # The shell serves every route under its base, framing the app at the same route.
    shell = run.succeed(f"curl -fsS http://localhost:2731{base}/review/orders/1042")
    assert f'"appBase":"{base}/review-app"' in shell, shell[:600]

    # The CLI talks to the running service.
    assert "no open notes" in run.succeed("review list")
    status = json.loads(run.succeed("review status | sed -n '/^{/,/^}/p'"))
    assert status["target"]["port"] == 5173, status

    # Stopping Review stops the proxy and the dev server.
    run.succeed("scooter-service stop review")
    run.wait_until_fails("systemctl is-active webservice-review-app")
    run.wait_until_fails("systemctl is-active webservice-review-dev")
    run.shutdown()

    # 3. unit: starting Review starts the agent's unit, and the proxy serves it.
    unit.wait_for_unit("default.target")
    unit.fail("systemctl is-active acme")
    unit.fail("systemctl cat webservice-review-dev")
    unit.succeed("scooter-service start review")
    unit.wait_for_unit("acme.service")
    serves_app(unit, "/")
  '';
}
