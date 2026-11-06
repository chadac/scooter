# nixosTest: contrib/mcpservers' sandbox half, booted. A fake broker hands out the
# owner's servers; sync starts each as mcp-user@<name>, lists it in the runtime
# manifest beside a declared server, and follows a change in Settings.

{ pkgs, lib, sandboxModule }:

let
  # A fake broker: /mcpservers/servers returns whatever /tmp/servers.json holds.
  fakeBroker = pkgs.writeText "fake-broker.py" ''
    import http.server, pathlib

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/mcpservers/servers" or self.headers.get("Authorization") != "Bearer sandbox-token":
                self.send_response(403); self.end_headers(); return
            body = pathlib.Path("/tmp/servers.json").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    http.server.HTTPServer(("127.0.0.1", 8080), H).serve_forever()
  '';

  # A stdio MCP server whose `echo` tool reports its argv.
  echoServer = pkgs.writeScriptBin "mcp-echo" ''
    #!${pkgs.python3}/bin/python3
    import json, sys
    def reply(i, result): print(json.dumps({"jsonrpc": "2.0", "id": i, "result": result}), flush=True)
    for line in sys.stdin:
        m = json.loads(line)
        if "id" not in m: continue
        method, i = m["method"], m["id"]
        if method == "initialize":
            reply(i, {"protocolVersion": m["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "echo", "version": "1"}})
        elif method == "tools/list":
            reply(i, {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object"}}]})
        elif method == "tools/call":
            reply(i, {"content": [{"type": "text", "text": "argv:" + " ".join(sys.argv[1:])}]})
        else:
            print(json.dumps({"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": method}}), flush=True)
  '';

  # Stands in for `nix run`, which needs a registry.
  fakeNix = pkgs.writeShellScriptBin "nix" ''
    [ "$1" = run ] && [ "$2" = "nixpkgs#mcp-echo" ] && [ "$3" = "--" ] || { echo "fake nix: $*" >&2; exit 2; }
    shift 3
    exec ${echoServer}/bin/mcp-echo "$@"
  '';

  servers = args: builtins.toJSON {
    servers = [
      { name = "echo"; kind = "nixpkgs"; spec = "mcp-echo"; inherit args; }
      # Hidden by the declared server of the same name.
      { name = "declared"; kind = "nixpkgs"; spec = "mcp-echo"; args = [ ]; }
    ];
  };
in
pkgs.testers.runNixOSTest {
  name = "dev-env-contrib-mcpservers";
  globalTimeout = 900;

  nodes.machine = { ... }: {
    imports = [ sandboxModule ../contrib/mcpservers/sandbox.nix ];
    environment.systemPackages = [ pkgs.curl (lib.hiPrio fakeNix) ];
    programs.scooterMcpServers.syncInterval = "5s";

    # Takes the range's first port, which sync must skip.
    mcpServers.declared = {
      enable = true;
      port = 9780;
      stdioCommand = "${echoServer}/bin/mcp-echo declared";
    };

    environment.etc."broker-token".text = "sandbox-token";
    environment.etc."servers-1.json".text = servers [ "--one" ];
    environment.etc."servers-2.json".text = servers [ "--two" "with space" ];
    environment.etc."servers-none.json".text = ''{"servers": []}'';
    systemd.tmpfiles.rules = [ "d /workspace 0755 root root -" ];
    systemd.services.scooter-mcp-servers-sync.environment = {
      BROKER_URL = "http://127.0.0.1:8080";
      BROKER_TOKEN_PATH = "/etc/broker-token";
    };
    systemd.services.fake-broker = {
      wantedBy = [ "multi-user.target" ];
      before = [ "scooter-mcp-servers-sync.service" ];
      preStart = "cp /etc/servers-1.json /tmp/servers.json";
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${fakeBroker}";
    };
  };

  testScript = ''
    import json

    hdrs = "-H 'content-type: application/json' -H 'accept: application/json, text/event-stream'"
    call = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{}}}'

    def echo(port):
        return machine.succeed(f"curl -fsS -X POST http://127.0.0.1:{port}/mcp {hdrs} -d '{call}'")

    machine.wait_for_unit("default.target")

    with subtest("sync starts the owner's server on the next free port"):
        machine.wait_until_succeeds("systemctl is-active --quiet mcp-user@echo.service", timeout=120)
        runtime = json.loads(machine.succeed("cat /run/scooter/mcp-servers.runtime.json"))
        assert [s["name"] for s in runtime["servers"]] == ["echo"], runtime
        srv = runtime["servers"][0]
        assert srv["port"] == 9781 and srv["unit"] == "mcp-user@echo", srv
        machine.wait_for_open_port(9781, timeout=120)
        assert "argv:--one" in echo(9781)

    with subtest("the port is open to the pod network"):
        machine.succeed("iptables -S nixos-fw | grep -E -- '--dport 9780:9799 .*-j nixos-fw-accept'")

    with subtest("scooter-mcp sees runtime and declared servers together"):
        listing = machine.succeed("scooter-mcp list")
        assert "echo" in listing and "declared" in listing, listing
        machine.succeed("scooter-mcp status echo | grep -q 'unit=mcp-user@echo'")
        machine.succeed("scooter-mcp-servers list | grep -q echo")

    with subtest("a changed server restarts with its new arguments, spaces kept"):
        machine.succeed("cp /etc/servers-2.json /tmp/servers.json")
        machine.wait_until_succeeds(f"curl -fsS -X POST http://127.0.0.1:9781/mcp {hdrs} -d '{call}' | grep -q 'argv:--two with space'", timeout=120)

    with subtest("a removed server stops and leaves the manifest"):
        machine.succeed("cp /etc/servers-none.json /tmp/servers.json")
        machine.wait_until_fails("systemctl is-active --quiet mcp-user@echo.service", timeout=60)
        runtime = json.loads(machine.succeed("cat /run/scooter/mcp-servers.runtime.json"))
        assert runtime["servers"] == [], runtime
        machine.succeed("systemctl is-active --quiet mcp-declared.service")

    with subtest("a broker outage keeps the servers and is reported"):
        machine.succeed("cp /etc/servers-1.json /tmp/servers.json")
        machine.wait_until_succeeds("systemctl is-active --quiet mcp-user@echo.service", timeout=60)
        machine.succeed("systemctl stop fake-broker")
        machine.fail("BROKER_URL=http://127.0.0.1:8080 BROKER_TOKEN_PATH=/etc/broker-token scooter-mcp-servers sync")
        machine.succeed("systemctl is-active --quiet mcp-user@echo.service")
        machine.succeed("scooter-mcp-servers list | grep -q 'could not read'")
  '';
}
