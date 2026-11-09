# nixosTest: contrib/web-review's sandbox half, booted. The proxy and CLI are covered
# by their Go tests and the overlay by tests/ui/review.ui.mjs; what only a VM shows is
# the wiring: Review is off until enabled, then listed; the CLI starts the service;
# the proxy runs the dev server as its own unit and serves it under the base path
# with the overlay injected; and stopping Review stops all of it.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-contrib-web-review";

  nodes = let
    common = {
      imports = [ sandboxModule ../contrib/web-review/sandbox.nix ];
      boot.kernelParams = [ "CONVERSATION_ID=conv-review" ];
      # Headless screenshots need chromium, which this test doesn't exercise.
      webReview.chromium = null;
      systemd.tmpfiles.rules = [ "d /workspace 0755 root root -" ];
      environment.systemPackages = [ pkgs.curl ];
    };
  in {
    # As shipped: Review off until the agent enables it.
    off = common;
    machine = { imports = [ common ]; webServices.review.enable = true; };
  };

  testScript = ''
    import json

    start_all()
    base = "/c/conv-review"

    # 0. Off by default: unlisted, and `review target` saves the app and says how to enable it.
    off.wait_for_unit("default.target")
    off.fail("grep -qs '\"review\"' /run/scooter/web-services.json")
    off.fail("systemctl cat webservice-review")
    out = off.succeed("cd /workspace && review target 5173")
    assert "webServices.review.enable = true" in out, out
    off.succeed("test -f /workspace/.scooter/review/config.json")

    machine.wait_for_unit("default.target")

    # 1. Both services reach the manifest; only Review is listed.
    data = {s["name"]: s for s in json.loads(machine.succeed("cat /run/scooter/web-services.json"))["services"]}
    assert "visibleInMenu" not in data["review"], data["review"]
    assert data["review-app"]["visibleInMenu"] is False, data["review-app"]
    assert "review " in machine.succeed("scooter-service list"), "Review isn't listed"

    # 2. `review target --run` saves the app and starts the service, which runs the dev
    # server with the base path in its environment.
    serve = "${pkgs.python3}/bin/python3 ${../contrib/web-review/example}/serve.py"
    machine.succeed(
        f"cd /workspace && review target --run '{serve} --port 5173 --base \"$REVIEW_BASE\"' --port 5173 >&2"
    )
    machine.wait_for_unit("webservice-review.service")
    machine.wait_for_unit("webservice-review-app.service")
    machine.wait_until_succeeds("systemctl is-active webservice-review-dev")
    listing = machine.succeed("scooter-service list")
    assert "review " in listing and "review-app" not in listing, listing

    # 3. A deep link under the base path reaches the app, framable, with the overlay.
    page = machine.wait_until_succeeds(
        f"curl -fsS -D /tmp/headers -H 'Sec-Fetch-Dest: iframe' http://localhost:2732{base}/review-app/orders/1042"
    )
    assert f'<script src="{base}/review-app/__review/overlay.js"' in page, page[:500]
    assert f'<base href="{base}/review-app/">' in page, page[:500]
    headers = machine.succeed("cat /tmp/headers").lower()
    assert "x-frame-options" not in headers, headers
    assert "frame-ancestors" not in headers, headers
    machine.succeed(f"curl -fsS http://localhost:2732{base}/review-app/__review/vendor/modern-screenshot.js | grep -q modernScreenshot")

    # 4. The shell serves every route under its base, framing the app at the same route.
    shell = machine.succeed(f"curl -fsS http://localhost:2731{base}/review/orders/1042")
    assert f'"appBase":"{base}/review-app"' in shell, shell[:600]

    # 5. The CLI talks to the running service.
    assert "no open notes" in machine.succeed("review list")
    status = json.loads(machine.succeed("review status | sed -n '/^{/,/^}/p'"))
    assert status["target"]["port"] == 5173, status

    # 6. Stopping Review stops the proxy and the dev server it started.
    machine.succeed("scooter-service stop review")
    machine.wait_until_fails("systemctl is-active webservice-review-app")
    machine.wait_until_fails("systemctl is-active webservice-review-dev")

    # 7. Clearing the target forgets the app.
    machine.succeed("review target --clear")
    machine.fail("test -e /workspace/.scooter/review/config.json")
  '';
}
