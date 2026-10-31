# nixosTest: commits follow the broker's /git/identity, the trailer credits the
# bot only when acting for a user, and repo hooks still run under the global hooksPath.

{ pkgs, lib, sandboxModule }:

let
  # A fake broker: /git/identity returns whatever /tmp/identity.json holds.
  fakeBroker = pkgs.writeText "fake-broker.py" ''
    import http.server, pathlib

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/git/identity" or self.headers.get("Authorization") != "Bearer sandbox-token":
                self.send_response(403); self.end_headers(); return
            body = pathlib.Path("/tmp/identity.json").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    http.server.HTTPServer(("127.0.0.1", 8080), H).serve_forever()
  '';
  bot = ''{"author": {"name": "scooter[bot]", "email": "1+scooter[bot]@users.noreply.github.com"}, "co_author": null}'';
  alice = ''{"author": {"name": "alice", "email": "2+alice@users.noreply.github.com"}, "co_author": "scooter[bot] <1+scooter[bot]@users.noreply.github.com>"}'';
in
pkgs.testers.runNixOSTest {
  name = "dev-env-git-identity";
  globalTimeout = 600;

  nodes.machine = { ... }: {
    imports = [ sandboxModule ];
    programs.scooterGitIdentity.interval = 1;
    environment.etc."broker-token".text = "sandbox-token";
    environment.etc."identity-bot.json".text = bot;
    environment.etc."identity-alice.json".text = alice;
    systemd.services.scooter-git-identity.environment = {
      BROKER_URL = "http://127.0.0.1:8080";
      BROKER_TOKEN_PATH = "/etc/broker-token";
    };
    systemd.services.fake-broker = {
      wantedBy = [ "multi-user.target" ];
      before = [ "scooter-git-identity.service" ];
      preStart = "cp /etc/identity-bot.json /tmp/identity.json";
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${fakeBroker}";
    };
  };

  testScript = ''
    machine.wait_for_unit("scooter-git-identity.service")
    machine.wait_until_succeeds("git config --get user.name | grep -qx 'scooter\\[bot\\]'")

    machine.succeed(
      "mkdir -p /tmp/repo && cd /tmp/repo && git init -q",
      # A repo's own hook must still run under the global hooksPath.
      "printf '#!/bin/sh\\ntouch /tmp/repo-hook-ran\\n' > /tmp/repo/.git/hooks/pre-commit",
      "chmod +x /tmp/repo/.git/hooks/pre-commit",
    )

    with subtest("not acting: the bot authors, no trailer"):
        machine.succeed("cd /tmp/repo && git commit -q --allow-empty -m one")
        machine.succeed("test -e /tmp/repo-hook-ran")
        assert machine.succeed("cd /tmp/repo && git log -1 --format=%an").strip() == "scooter[bot]"
        assert "Co-authored-by" not in machine.succeed("cd /tmp/repo && git log -1 --format=%B")

    with subtest("acting: the user authors, the bot is credited once"):
        machine.succeed("cp /etc/identity-alice.json /tmp/identity.json")
        machine.wait_until_succeeds("git config --get user.name | grep -qx alice")
        machine.succeed("cd /tmp/repo && git commit -q --allow-empty -m two")
        commit = machine.succeed("cd /tmp/repo && git log -1 --format='%an <%ae>%n%B'")
        assert commit.startswith("alice <2+alice@users.noreply.github.com>"), commit
        assert commit.count("Co-authored-by: scooter[bot] <1+scooter[bot]@users.noreply.github.com>") == 1, commit
        machine.succeed("cd /tmp/repo && git commit -q --amend --allow-empty --no-edit")
        amended = machine.succeed("cd /tmp/repo && git log -1 --format=%B")
        assert amended.count("Co-authored-by:") == 1, amended

    with subtest("turned shared: back to the bot"):
        machine.succeed("cp /etc/identity-bot.json /tmp/identity.json")
        machine.wait_until_succeeds("git config --get user.name | grep -qx 'scooter\\[bot\\]'")
        machine.fail("git config --get scooter.coauthor")
  '';
}
