# nixosTest: the scooter-rebuild entrypoint CLI — the agent's environment interface.
#
# Boots the sandbox-os config and exercises scooter-rebuild's module-authoring workflow
# (new / list / show / rm on /etc/scooter/modules) + the dispatch to the switch/status
# machinery + the REGISTRY subcommands (search / add / detach / attached / publish)
# against a FAKE agent-broker shim (canned JSON — no real broker). Does NOT run a full
# toplevel rebuild (that offline path is covered by dev-env-scooter-module + Tier-2);
# this proves the CLI surface + the /etc/scooter file operations against the real dirs.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-scooter-rebuild";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];
    programs.scooterModule.enable = true;
    # The in-pod build isn't exercised here, but the option is required.
    programs.scooterModule.nixpkgs = lib.mkForce "/dev/null";
    programs.scooterModule.applyOnBoot = lib.mkForce false;
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # /etc/scooter/modules exists (the tmpfiles symlink -> workspace PVC dir).
    machine.succeed("test -L /etc/scooter/modules")
    machine.succeed("test -d /etc/scooter/modules")

    # list: empty initially -> the "no modules yet" hint (exit 0).
    out = machine.succeed("scooter-rebuild module list")
    assert "no modules yet" in out, f"expected empty hint, got: {out!r}"

    # new: creates modules/<name>.nix from a template on the PVC dir.
    machine.succeed("scooter-rebuild module new mytool")
    machine.succeed("test -f /etc/scooter/modules/mytool.nix")
    # it lands on the real PVC path behind the symlink.
    machine.succeed("test -f /workspace/.scooter/modules/mytool.nix")

    # list now shows it (by bare name).
    listed = machine.succeed("scooter-rebuild module list").strip()
    assert listed == "mytool", f"expected 'mytool', got: {listed!r}"

    # show prints the module contents.
    shown = machine.succeed("scooter-rebuild module show mytool")
    assert "NixOS module" in shown, f"template not shown: {shown!r}"

    # new on an existing name FAILS (don't clobber).
    machine.fail("scooter-rebuild module new mytool")

    # edit: opens $EDITOR on the module file. Use a single-binary editor wrapper (a
    # script that appends a marker) to prove edit targets the right path.
    machine.succeed(
        "printf '#!/bin/sh\\nprintf \"# edited\\\\n\" >> \"$1\"\\n' > /tmp/ed && chmod +x /tmp/ed"
    )
    machine.succeed("EDITOR=/tmp/ed scooter-rebuild module edit mytool")
    machine.succeed("grep -q '# edited' /etc/scooter/modules/mytool.nix")
    # edit on a NON-existent module creates it first (then edits).
    machine.succeed("EDITOR=/tmp/ed scooter-rebuild module edit fresh")
    machine.succeed("test -f /etc/scooter/modules/fresh.nix")
    machine.succeed("scooter-rebuild module rm fresh")

    # path-traversal names are rejected.
    machine.fail("scooter-rebuild module new ../evil")
    machine.fail("scooter-rebuild module show foo/bar")

    # rm deletes it; list is empty again.
    machine.succeed("scooter-rebuild module rm mytool")
    machine.fail("test -e /etc/scooter/modules/mytool.nix")
    assert "no modules yet" in machine.succeed("scooter-rebuild module list")

    # --- registry subcommands (against a FAKE broker HTTP server) ----------------
    # scooter-rebuild bakes the REAL agent-broker into its PATH (runtimeInputs), so we
    # can't shadow it — instead stand up a tiny fake broker on localhost + a token file,
    # exercising the real agent-broker -> HTTP -> JSON path. The fake echoes the publish
    # body to /tmp so we can assert it.
    machine.succeed(
        "cat > /root/fakebroker.py <<'PY'\n"
        "import json\n"
        "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
        "from urllib.parse import urlparse, parse_qs\n"
        "class H(BaseHTTPRequestHandler):\n"
        "    def _send(self, code, obj):\n"
        "        b = json.dumps(obj).encode()\n"
        "        self.send_response(code); self.send_header('Content-Type','application/json')\n"
        "        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)\n"
        "    def do_GET(self):\n"
        "        u = urlparse(self.path)\n"
        "        if u.path == '/modules':\n"
        "            self._send(200, {'modules':[{'id':7,'name':'alpha','visibility':'public','description':'a demo'}]})\n"
        "        elif u.path in ('/modules/alpha','/modules/7'):\n"
        "            self._send(200, {'id':7,'name':'alpha','visibility':'public','version':1})\n"
        "        else:\n"
        "            self._send(404, {'detail':'module not found'})\n"
        "    def do_POST(self):\n"
        "        n = int(self.headers.get('Content-Length',0)); body = self.rfile.read(n)\n"
        "        open('/tmp/publish-body.json','wb').write(body)\n"
        "        self._send(201, {'id':42,'name':json.loads(body).get('name'),'visibility':json.loads(body).get('visibility','private'),'version':1})\n"
        "    def log_message(self, *a): pass\n"
        "HTTPServer(('127.0.0.1',8080), H).serve_forever()\n"
        "PY"
    )
    machine.succeed("mkdir -p /var/run/secrets/broker && echo faketoken > /var/run/secrets/broker/token")
    machine.succeed(
        "${pkgs.python3}/bin/python3 /root/fakebroker.py >/tmp/fb.log 2>&1 & echo started"
    )
    machine.wait_until_succeeds("${pkgs.curl}/bin/curl -sf http://127.0.0.1:8080/modules/alpha")

    # BROKER_URL points the real agent-broker at the fake; the token file is present.
    reg = "BROKER_URL=http://127.0.0.1:8080 "

    # search: prints the catalog rows.
    found = machine.succeed(reg + "scooter-rebuild module search demo")
    assert "alpha" in found and "#7" in found, f"search output: {found!r}"

    # attached: empty initially.
    assert "no registry modules attached" in machine.succeed("scooter-rebuild module attached")

    # add by NAME: records the canonical name in registry-modules.json (the mv happens
    # BEFORE the terminal switch, so use execute() and assert the file regardless of the
    # apply exit — no real toplevel is built here).
    machine.execute(reg + "scooter-rebuild module add alpha")
    machine.succeed("test -f /etc/scooter/registry-modules.json")
    assert machine.succeed("jq -r '.[]' /etc/scooter/registry-modules.json").strip() == "alpha"

    # add by ID resolves to the SAME canonical name -> idempotent (still just ['alpha']).
    machine.execute(reg + "scooter-rebuild module add 7")
    assert machine.succeed("jq -c . /etc/scooter/registry-modules.json").strip() == '[\"alpha\"]'

    # attached now lists it.
    assert machine.succeed("scooter-rebuild module attached").strip() == "alpha"

    # add an unknown ref FAILS and does NOT record anything.
    machine.fail(reg + "scooter-rebuild module add nope")
    assert machine.succeed("jq -c . /etc/scooter/registry-modules.json").strip() == '[\"alpha\"]'

    # detach removes it (again the mutation precedes the switch).
    machine.execute(reg + "scooter-rebuild module detach alpha")
    assert machine.succeed("jq -c . /etc/scooter/registry-modules.json").strip() == "[]"
    assert "no registry modules attached" in machine.succeed("scooter-rebuild module attached")

    # publish: POSTs the local module as files['module.nix']; needs a local module.
    machine.succeed("scooter-rebuild module new mytool")
    pub = machine.succeed(reg + "scooter-rebuild publish mytool")
    assert "#42" in pub, f"publish output: {pub!r}"
    # The request body carried name + files.module.nix (the local module contents).
    assert machine.succeed("jq -r '.name' /tmp/publish-body.json").strip() == "mytool"
    assert "NixOS module" in machine.succeed("jq -r '.\"files\".\"module.nix\"' /tmp/publish-body.json")
    assert machine.succeed("jq -r '.visibility' /tmp/publish-body.json").strip() == "private"
    # --public flips visibility.
    machine.succeed(reg + "scooter-rebuild publish mytool --public --description 'hi'")
    assert machine.succeed("jq -r '.visibility' /tmp/publish-body.json").strip() == "public"
    assert machine.succeed("jq -r '.description' /tmp/publish-body.json").strip() == "hi"
    # publishing a NON-existent local module fails.
    machine.fail(reg + "scooter-rebuild publish ghost")
    machine.succeed("scooter-rebuild module rm mytool")

    # dispatch: status wraps scooter-env-status (idle before any switch -> ready, exit 0).
    st = machine.succeed("scooter-rebuild status")
    assert "ready" in st, f"status not ready: {st!r}"

    # unknown command / subcommand -> usage + non-zero.
    machine.fail("scooter-rebuild bogus")
    machine.fail("scooter-rebuild module bogus")
    # --help prints the command list (exits 2 = usage; capture stderr).
    help = machine.succeed("scooter-rebuild --help 2>&1 || true")
    assert "scooter-rebuild switch" in help, f"help missing commands: {help!r}"
  '';
}
